import { spawnSync } from "node:child_process";

export function copyTextToClipboard(text) {
  const attempts = [];

  if (process.platform === "win32") {
    attempts.push({
      command: "cmd",
      args: ["/c", "clip"]
    });
  } else if (process.platform === "darwin") {
    attempts.push({
      command: "pbcopy",
      args: []
    });
  } else {
    attempts.push(
      { command: "wl-copy", args: [] },
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] }
    );
  }

  for (const attempt of attempts) {
    const result = spawnSync(attempt.command, attempt.args, {
      input: text,
      encoding: "utf8"
    });

    if (!result.error && result.status === 0) {
      return true;
    }
  }

  return false;
}
