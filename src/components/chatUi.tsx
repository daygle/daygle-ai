import { useState } from "react";
import { Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Remove raw tool-call JSON that some models emit as plain text instead of
 * using the structured tool_calls format. The backend still executes these
 * (they show up as tool cards), so they must never leak into a chat bubble.
 * Handles complete objects, multi-line/nested arguments, ```json fences, and
 * a trailing *incomplete* object mid-stream (so partial JSON never flashes).
 */
export function stripToolJson(text: string): string {
  const withoutFences = text.replace(/```(?:json|tool_code)?/gi, "");
  let result = "";
  let cursor = 0;
  const toolPrefix = /\{\s*"name"\s*:/g;

  for (;;) {
    toolPrefix.lastIndex = cursor;
    const match = toolPrefix.exec(withoutFences);
    if (!match) {
      result += withoutFences.slice(cursor);
      break;
    }

    const start = match.index;
    result += withoutFences.slice(cursor, start);
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < withoutFences.length; index++) {
      const character = withoutFences[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) {
        end = index + 1;
        break;
      }
    }

    // A partial tool object is hidden while it streams; a complete object is
    // removed only when it parses as the tool-call shape we expect.
    if (end < 0) break;
    try {
      const candidate = JSON.parse(withoutFences.slice(start, end)) as { name?: unknown; arguments?: unknown };
      if (typeof candidate.name === "string" && candidate.arguments !== undefined) {
        cursor = end;
        continue;
      }
    } catch {
      // Leave malformed assistant text visible rather than deleting content.
    }
    cursor = start + 1;
  }

  return result
    .replace(/\{\s*"file"\s*:\s*"[^"]+"\s*,\s*"line"\s*:\s*\d+\s*\}/g, "")
    .replace(/(?:bash\s+)?(?:list_files|read_file|search|write_file|str_replace|run_command)\s*\([^)]*\)/gi, "")
    .replace(/(?:bash\s+)?cd\s+\S+\s+.+/gi, "")
    .trim();
}

/**
 * Only allow genuine image mime types in data: URLs. A user-controlled mime
 * (e.g. `text/html`) would let the data URL carry HTML, and a non-image
 * payload must never be reinterpreted that way.
 */
export function imageMime(mime: string | undefined): string {
  return mime && /^image\/[a-z0-9.+-]+$/i.test(mime) ? mime : "image/png";
}

/** Lightweight markdown for assistant messages - headings, lists, code, links. */
export function Markdown({ children }: { children: string }) {
  const [checked, setChecked] = useState<Set<number>>(() => new Set());

  return (
    <div className="space-y-2 text-sm leading-relaxed [&_a]:text-accent [&_a]:underline [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-0 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ node: _node, className, children, ...props }) {
            const inline = !className;
            return inline ? (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...props}>
                {children}
              </code>
            ) : (
              <code className={`${className ?? ""} font-mono`} {...props}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            return (
              <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[12px] leading-relaxed">
                {children}
              </pre>
            );
          },
          li({ node, children, ...props }) {
            // GFM task list items have dataChecked set by remarkGfm → rehype
            const dataChecked = node?.properties?.dataChecked;
            if (dataChecked !== undefined) {
              // Use a stable index from position info to track local toggle state
              const pos = node ? (node.position?.start.line ?? 0) * 1000 + (node.position?.start.column ?? 0) : 0;
              const isChecked = dataChecked === true || dataChecked === "true" || checked.has(pos);
              return (
                <li
                  className="!ml-4 !list-none flex items-start gap-2 py-0.5"
                  {...props}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    readOnly
                    onClick={(e) => {
                      e.stopPropagation();
                      setChecked((prev) => {
                        const next = new Set(prev);
                        if (next.has(pos)) next.delete(pos); else next.add(pos);
                        return next;
                      });
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-border bg-background accent-accent"
                  />
                  <span className="flex-1 leading-relaxed [&_p]:my-0">{children}</span>
                </li>
              );
            }
            return <li {...props}>{children}</li>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Copy text to clipboard, with a fallback when the Clipboard API is blocked. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API may be blocked (non-secure context, permissions, etc.).
      // Fall back to the legacy execCommand approach.
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      onClick={handleCopy}
      className="ml-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      title="Copy"
    >
      <Copy className="h-3 w-3" />
      {copied && <span className="ml-1 text-[10px] text-accent">copied</span>}
    </button>
  );
}