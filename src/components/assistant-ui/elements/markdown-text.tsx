"use client";

import "@assistant-ui/react-markdown/styles/dot.css";

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { type FC, memo, useMemo, useRef } from "react";
import type { TextMessagePartProps } from "@assistant-ui/react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { ImageZoom } from "@/components/assistant-ui/elements/image";
import { useT } from "@/i18n/react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { getApiBase } from "@/lib/api";
import { detectMediaKind, resolveMediaSrc } from "@/lib/localMedia";
import { perfCount } from "@/lib/perf";
import { canOpenTarget, openTarget } from "@/lib/open-target";
import { cn } from "@/lib/utils";

type MarkdownTextProps = Partial<TextMessagePartProps> & {
  components?: Parameters<typeof memoizeMarkdownComponents>[0];
  /**
   * Typewriter reveal (`MarkdownTextPrimitive`'s default is `true`).
   *
   * Off here on purpose. The animator drains the *already received* text at no
   * more than ~2.5ms per character, while every other part - a tool card, the
   * indicator - renders the moment it lands. A captured run shows the cost: the
   * app had parsed the authoritative 172-character thinking payload 31ms
   * *before* the tool card was painted, yet the panel above the tool card went
   * from 69 to 172 characters over the next ~600ms. That reads as「工具卡都出来
   * 了，上面的 thinking 还在输出」even though the data was complete and in
   * order. Text now lands when it arrives; the frame-budgeted commit in
   * `streamCommitBuffer` is what keeps the write rate honest.
   */
  smooth?: boolean;
};

const useShallowStable = <T extends Record<string, unknown> | undefined>(
  value: T,
): T => {
  const ref = useRef(value);
  if (value !== ref.current) {
    const prev = ref.current;
    const stable =
      value !== undefined &&
      prev !== undefined &&
      Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((key) => prev[key] === value[key]);
    if (!stable) ref.current = value;
  }
  return ref.current;
};

const MarkdownTextImpl: FC<MarkdownTextProps> = ({ components, text, smooth = false, status }) => {
  // `MarkdownText` is memoised, so this counts the renders that actually happen
  // per streamed token; `chars` is the volume handed to the markdown parser.
  perfCount("markdown.render", { chars: text?.length ?? 0 });
  const stableComponents = useShallowStable(components);
  const markdownComponents = useMemo(() => {
    if (!stableComponents) return defaultComponents;
    return {
      ...defaultComponents,
      ...memoizeMarkdownComponents(stableComponents),
    };
  }, [stableComponents]);

  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md"
      components={markdownComponents}
      urlTransform={keepRawUrl}
      smooth={smooth}
      // `useDeferredValue` defers this component on its own, so a sibling tool card
      // (same parts array, no deferral of its own) can paint one render *before*
      // the text above it catches up - the residual version of the same symptom
      // the `smooth` default caused. Live text therefore renders eagerly; settled
      // text (history, finished blocks) keeps the deferral, which is what protects
      // session switches from a synchronous markdown re-parse per message.
      defer={status?.type !== "running"}
    />
  );
};

/**
 * react-markdown drops every URL whose protocol is not http(s)/ircs/mailto/xmpp,
 * which silently kills `data:` and `file:` images before any component sees them.
 * The renderers below decide what is loadable, and links are still gated by
 * `canOpenTarget`, so the raw value is kept.
 */
function keepRawUrl(value: string): string {
  return value;
}

export const MarkdownText = memo(MarkdownTextImpl);

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const t = useT();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  return (
    <div className="aui-code-header-root border-border/50 bg-muted/50 mt-3 flex items-center justify-between rounded-t-xl border border-b-0 px-3.5 py-1.5 text-xs">
      <span className="aui-code-header-language text-muted-foreground font-medium lowercase">
        {language}
      </span>
      <TooltipIconButton tooltip={t("message.copyCode")} onClick={onCopy}>
        {!isCopied && (
          <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
        )}
        {isCopied && (
          <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
        )}
      </TooltipIconButton>
    </div>
  );
};

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "aui-md-h1 mt-5 mb-2 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "aui-md-h2 mt-5 mb-2 scroll-m-20 text-lg font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "aui-md-h3 mt-4 mb-1.5 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        "aui-md-h4 mt-3.5 mb-1 scroll-m-20 text-base font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      className={cn(
        "aui-md-h5 mt-3 mb-1 text-sm font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn(
        "aui-md-h6 mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn(
        "aui-md-p my-3 leading-[1.85] first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  a: ({ className, href, onClick, ...props }) => {
    const target = canOpenTarget(href) ? href : undefined;

    return (
      <a
        className={cn(
          "aui-md-a text-primary hover:text-primary/80 underline underline-offset-2",
          className,
        )}
        href={href}
        rel={target ? "noreferrer noopener" : undefined}
        target={target ? "_blank" : undefined}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || !target) {
            event.preventDefault();
            return;
          }

          event.preventDefault();
          void openTarget(target);
        }}
        {...props}
      />
    );
  },
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "aui-md-blockquote border-muted-foreground/30 text-muted-foreground my-3 border-s-2 ps-4",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "aui-md-ul marker:text-muted-foreground my-3 ms-5 list-disc [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "aui-md-ol marker:text-muted-foreground my-3 ms-5 list-decimal [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr
      className={cn("aui-md-hr border-muted-foreground/20 my-3", className)}
      {...props}
    />
  ),
  // `overflow-x-auto` has to sit on a wrapper: `overflow` on the `<table>`
  // itself never creates a scroll container, so a wide table used to widen the
  // thread viewport and give the whole window a horizontal scrollbar.
  // `[overflow-wrap:anywhere]` on the cells is the second half of the fix:
  // `break-word` (inherited from the message body) does not shrink a cell's
  // min-content width, so one long unbroken token - an inline-code config blob
  // - was enough to blow the table past the container.
  table: ({ className, ...props }) => (
    <div
      data-slot="aui_md-table-wrapper"
      className="aui-md-table-wrapper my-3 max-w-full overflow-x-auto"
    >
      <table
        className={cn(
          "aui-md-table w-full border-separate border-spacing-0",
          className,
        )}
        {...props}
      />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th bg-muted border-border border-s border-b border-t px-3 py-1.5 text-start font-medium [overflow-wrap:anywhere] first:rounded-ss-lg last:rounded-se-lg last:border-e [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td border-border border-s border-b px-3 py-1.5 text-start [overflow-wrap:anywhere] last:border-e [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-es-lg [&:last-child>td:last-child]:rounded-ee-lg",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("aui-md-li leading-[1.85]", className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong
      className={cn("aui-md-strong font-semibold", className)}
      {...props}
    />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "aui-md-pre border-border/50 bg-muted/30 overflow-x-auto rounded-t-none rounded-b-xl border border-t-0 p-3.5 text-[13px] leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.86em]",
          className,
        )}
        {...props}
      />
    );
  },
  img: ({ className, src, alt, ...props }) => <MarkdownMedia className={className} src={src} alt={alt} {...props} />,
  CodeHeader,
});

/**
 * `![](...)` in an answer. Local paths cannot be loaded by the WebView directly,
 * and a video written as an image still has to be played, not broken.
 */
const MarkdownMedia: FC<React.ComponentProps<"img">> = ({
  className,
  src,
  alt,
  ...rest
}) => {
  const t = useT();
  const label = alt || t("image.contentLabel");
  const resolved = resolveMediaSrc(typeof src === "string" ? src : undefined, getApiBase());
  if (!resolved) {
    return null;
  }

  if (detectMediaKind(src) === "video") {
    return (
      <video
        data-slot="aui_md-media-video"
        src={resolved}
        aria-label={label}
        controls
        preload="metadata"
        playsInline
        className={cn(
          "aui-md-media-video border-border/50 my-3 block h-auto w-full max-w-2xl rounded-xl border bg-black/5",
          className,
        )}
      />
    );
  }

  return (
    <ImageZoom src={resolved} alt={label}>
      <img
        data-slot="aui_md-media-image"
        src={resolved}
        alt={alt ?? ""}
        loading="lazy"
        decoding="async"
        className={cn(
          "aui-md-media-image border-border/50 my-3 block h-auto max-w-full rounded-lg border",
          className,
        )}
        {...rest}
      />
    </ImageZoom>
  );
};
