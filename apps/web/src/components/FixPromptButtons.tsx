import { useState } from "react";
import { fetchFixPrompt } from "../lib/api";
import { t } from "../lib/strings";

interface Props {
  runId: string;
  /** Test seam. */
  load?: (runId: string) => Promise<string>;
}

/** Copy or download the Markdown task meant for an AI coding agent. */
export function FixPromptButtons({ runId, load = fetchFixPrompt }: Props) {
  const [state, setState] = useState<"idle" | "busy" | "copied" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  const run = async (action: "copy" | "download") => {
    setState("busy");
    try {
      const text = await load(runId);
      if (action === "copy") {
        await navigator.clipboard.writeText(text);
        setState("copied");
      } else {
        const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `fix-prompt-${runId}.md`;
        link.click();
        URL.revokeObjectURL(url);
        setState("saved");
      }
      window.setTimeout(() => setState("idle"), 2500);
    } catch (e) {
      setMessage((e as Error).message);
      setState("error");
    }
  };

  return (
    <div className="fix-prompt" role="group" aria-label={t.fixPrompt} title={t.fixPromptHint}>
      <span className="muted small">{t.fixPrompt}</span>
      <button type="button" className="btn" disabled={state === "busy"} onClick={() => run("copy")}>
        {state === "copied" ? t.copied : t.fixPromptCopy}
      </button>
      <button
        type="button"
        className="btn"
        disabled={state === "busy"}
        onClick={() => run("download")}
      >
        {state === "saved" ? t.copied : t.fixPromptDownload}
      </button>
      {state === "error" && (
        <span role="alert" className="small">
          {message}
        </span>
      )}
    </div>
  );
}
