import { AlertCircle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"

type PluginErrorProps = {
  message: string
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

export function PluginError({ message }: PluginErrorProps) {
  return (
    <Alert
      variant="destructive"
      className="flex items-center gap-2 [&>svg]:static [&>svg]:translate-y-0 [&>svg~*]:pl-0 [&>svg+div]:translate-y-0"
    >
      <AlertCircle className="h-4 w-4" />
      <AlertDescription className="select-text cursor-text min-w-0"><p className="font-medium">無法取得用量</p><details className="mt-1 text-xs"><summary className="cursor-pointer">查看來源訊息</summary><div className="mt-1 break-words">{formatMessage(message)}</div></details></AlertDescription>
    </Alert>
  )
}
