import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { errorMessage } from "./errors.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  logFile?: string;
  check?: boolean;
}
export type Executor = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

/** All external commands use argv directly; no host shell or credential-bearing command strings. */
export const execute: Executor = async (command, args, options = {}) => {
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    let stdout = "",
      stderr = "",
      timedOut = false,
      overflow = false;
    const log = options.logFile
      ? createWriteStream(options.logFile, { flags: "a", mode: 0o600 })
      : undefined;
    log?.on("error", (error) => {
      child.kill("SIGKILL");
      reject(error);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 60_000);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (stream: "stdout" | "stderr", chunk: string) => {
      if (log) {
        if (!log.write(chunk)) child[stream]?.pause();
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > 8_000_000) {
        overflow = true;
        child.kill("SIGKILL");
      }
    };
    log?.on("drain", () => {
      child.stdout?.resume();
      child.stderr?.resume();
    });
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      log?.end();
      reject(error);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      try {
        if (log) {
          log.end();
          await finished(log);
        }
        if (timedOut)
          throw new Error(
            `${command} timed out. See the run logs if available.`,
          );
        if (overflow)
          throw new Error(`${command} output exceeded the 8 MB limit.`);
        resolve({ code: code ?? (signal ? 130 : 1), stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
  if (options.check !== false && result.code !== 0) {
    throw new Error(
      `${command} exited with ${result.code}${options.logFile ? `; see ${options.logFile}` : `: ${errorMessage(result.stderr.trim())}`}`,
    );
  }
  return result;
};
