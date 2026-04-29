import { AlertCircle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"

type PluginErrorProps = {
  message: string
  contextLabel?: string
  contextAccountId?: string | null
}

function formatMessage(message: string) {
  const parts = message.split(/`([^`]+)`/)
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <code
        key={`code-${index}`}
        className="rounded bg-muted px-1 font-mono text-[0.75rem] leading-tight"
      >
        {part}
      </code>
    ) : (
      part
    )
  )
}

export function PluginError({ message, contextLabel, contextAccountId }: PluginErrorProps) {
  return (
    <Alert
      variant="destructive"
      className="flex items-center gap-2 [&>svg]:static [&>svg]:translate-y-0 [&>svg~*]:pl-0 [&>svg+div]:translate-y-0"
    >
      <AlertCircle className="h-4 w-4" />
      <AlertDescription className="select-text cursor-text">
        {contextLabel && (
          <span
            className="mr-2 inline-flex max-w-[12rem] truncate rounded border border-destructive/30 px-1.5 py-0.5 text-[11px] text-muted-foreground"
            title={contextAccountId ? `Account ID: ${contextAccountId}` : undefined}
          >
            {contextLabel}
          </span>
        )}
        {formatMessage(message)}
      </AlertDescription>
    </Alert>
  )
}
