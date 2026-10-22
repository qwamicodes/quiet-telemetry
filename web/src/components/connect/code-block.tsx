import { CopyButton } from '@/components/copy-button'

/** A config snippet: file name, Copy (the real text), and the text as shown (token masked). */
export function CodeBlock({ file, shown, copy }: { file: string; shown: string; copy: string }) {
  return (
    <figure className="border bg-code">
      <figcaption className="flex h-9 items-center justify-between border-b pr-1.5 pl-3 font-mono text-[11px] text-muted-foreground">
        {file}
        <CopyButton text={copy} what="Config" variant="ghost" />
      </figcaption>
      <pre className="overflow-x-auto px-3 py-3 font-mono text-[12.5px] leading-5" data-testid="snippet">
        {shown}
      </pre>
    </figure>
  )
}
