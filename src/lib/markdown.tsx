import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { getApiBase } from "./api";
import { detectMediaKind, resolveMediaSrc } from "./localMedia";
import { canOpenTarget, openTarget } from "./open-target";

const markdownComponents: Components = {
  a({ href, children, ...props }) {
    const target = canOpenTarget(href) ? href : undefined;
    return (
      <a
        href={href}
        rel={target ? "noreferrer noopener" : undefined}
        target={target ? "_blank" : undefined}
        onClick={(event) => {
          if (!target) {
            return;
          }

          event.preventDefault();
          void openTarget(target);
        }}
        {...props}
      >
        {children}
      </a>
    );
  },
  // Same rule as the chat markdown: local paths are only readable through the
  // local server, and a video has to be played rather than shown as an image.
  img({ src, alt, className, ...props }) {
    const resolved = resolveMediaSrc(src, getApiBase());
    if (!resolved) {
      return null;
    }
    if (detectMediaKind(src) === "video") {
      return (
        <video
          src={resolved}
          aria-label={alt}
          controls
          preload="metadata"
          playsInline
          className={className}
        />
      );
    }
    return (
      <img src={resolved} alt={alt ?? ""} loading="lazy" className={className} {...props} />
    );
  },
};

export function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown components={markdownComponents} rehypePlugins={[rehypeSanitize]} remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
