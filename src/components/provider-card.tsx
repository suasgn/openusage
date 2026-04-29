import { useMemo } from "react"
import { ExternalLink, Hourglass, RefreshCw } from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SkeletonLines } from "@/components/skeleton-lines"
import { PluginError } from "@/components/plugin-error"
import { MetricLineGroups, isErrorBadge } from "@/components/provider-card-lines"
import { useNowTicker } from "@/hooks/use-now-ticker"
import { REFRESH_COOLDOWN_MS, type DisplayMode, type ResetTimerDisplayMode } from "@/lib/settings"
import type { ManifestLine, MetricLine, PluginLink } from "@/lib/plugin-types"
import { getBaseMetricLabel, splitAccountScopedLabel } from "@/lib/account-scoped-label"

interface ProviderCardProps {
  name: string
  plan?: string
  links?: PluginLink[]
  accountOrder?: string[]
  showSeparator?: boolean
  loading?: boolean
  error?: string | null
  lines?: MetricLine[]
  skeletonLines?: ManifestLine[]
  lastManualRefreshAt?: number | null
  onRetry?: () => void
  scopeFilter?: "overview" | "all"
  displayMode: DisplayMode
  resetTimerDisplayMode?: ResetTimerDisplayMode
  onResetTimerDisplayModeToggle?: () => void
}

type AccountLineGroup = {
  accountLabel: string
  accountId: string | null
  plan: string | null
  lines: MetricLine[]
}

function removeAccountPrefix(line: MetricLine): {
  accountLabel: string | null
  accountId: string | null
  line: MetricLine
} {
  const { accountLabel, accountId, metricLabel } = splitAccountScopedLabel(line.label)
  if (!accountLabel) return { accountLabel: null, accountId: null, line }

  return {
    accountLabel,
    accountId,
    line: { ...line, label: metricLabel },
  }
}

export function ProviderCard({
  name,
  plan,
  links = [],
  accountOrder = [],
  showSeparator = true,
  loading = false,
  error = null,
  lines = [],
  skeletonLines = [],
  lastManualRefreshAt,
  onRetry,
  scopeFilter = "all",
  displayMode,
  resetTimerDisplayMode = "relative",
  onResetTimerDisplayModeToggle,
}: ProviderCardProps) {
  const cooldownRemainingMs = useMemo(() => {
    if (!lastManualRefreshAt) return 0
    const remaining = REFRESH_COOLDOWN_MS - (Date.now() - lastManualRefreshAt)
    return remaining > 0 ? remaining : 0
  }, [lastManualRefreshAt])

  // Filter lines based on scope - match by label since runtime lines can differ from manifest
  const overviewLabels = new Set(
    skeletonLines
      .filter(line => line.scope === "overview")
      .map(line => line.label)
  )
  const filteredSkeletonLines = scopeFilter === "all"
    ? skeletonLines
    : skeletonLines.filter(line => line.scope === "overview")
  const filteredLines = scopeFilter === "all"
    ? lines
    : lines.filter(line => overviewLabels.has(getBaseMetricLabel(line.label)))

  const groupedLines = useMemo(() => {
    const ungrouped: MetricLine[] = []
    const groups: AccountLineGroup[] = []
    const byAccount = new Map<string, AccountLineGroup>()

    for (const line of filteredLines) {
      const scoped = removeAccountPrefix(line)
      if (!scoped.accountLabel) {
        ungrouped.push(scoped.line)
        continue
      }

      const groupKey = `${scoped.accountLabel}::${scoped.accountId ?? ""}`
      let group = byAccount.get(groupKey)
      if (!group) {
        group = {
          accountLabel: scoped.accountLabel,
          accountId: scoped.accountId,
          plan: null,
          lines: [],
        }
        byAccount.set(groupKey, group)
        groups.push(group)
      }

      if (scoped.line.type === "badge" && scoped.line.label === "Plan") {
        group.plan = scoped.line.text
        continue
      }

      group.lines.push(scoped.line)
    }

    if (accountOrder.length > 0 && groups.length > 1) {
      const orderIndexById = new Map(accountOrder.map((accountId, index) => [accountId, index]))
      groups.sort((left, right) => {
        const leftOrder = left.accountId ? orderIndexById.get(left.accountId) : undefined
        const rightOrder = right.accountId ? orderIndexById.get(right.accountId) : undefined
        if (leftOrder === undefined && rightOrder === undefined) return 0
        if (leftOrder === undefined) return 1
        if (rightOrder === undefined) return -1
        return leftOrder - rightOrder
      })
    }

    return { ungrouped, groups }
  }, [accountOrder, filteredLines])

  const hasResetCountdown = filteredLines.some(
    (line) => line.type === "progress" && Boolean(line.resetsAt)
  )

  const now = useNowTicker({
    enabled: cooldownRemainingMs > 0 || hasResetCountdown,
    intervalMs: cooldownRemainingMs > 0 ? 1000 : 30_000,
    stopAfterMs: cooldownRemainingMs > 0 && !hasResetCountdown ? cooldownRemainingMs : null,
  })

  const inCooldown = lastManualRefreshAt
    ? now - lastManualRefreshAt < REFRESH_COOLDOWN_MS
    : false

  const visibleLinks = useMemo(
    () =>
      links
        .map((link) => ({
          label: link.label.trim(),
          url: link.url.trim(),
        }))
        .filter(
          (link) =>
            link.label.length > 0 &&
            link.url.length > 0 &&
            (link.url.startsWith("https://") || link.url.startsWith("http://"))
        ),
    [links]
  )

  // Format remaining cooldown time as "Xm Ys"
  const formatRemainingTime = () => {
    if (!lastManualRefreshAt) return ""
    const remainingMs = REFRESH_COOLDOWN_MS - (now - lastManualRefreshAt)
    if (remainingMs <= 0) return ""
    const totalSeconds = Math.ceil(remainingMs / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    if (minutes > 0) {
      return `Available in ${minutes}m ${seconds}s`
    }
    return `Available in ${seconds}s`
  }

  return (
    <div>
      <div className="py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="relative flex items-center">
            <h2 className="text-lg font-semibold" style={{ transform: "translateZ(0)" }}>{name}</h2>
            {onRetry && (
              loading ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-1 pointer-events-none opacity-50"
                  style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}
                  tabIndex={-1}
                >
                  <RefreshCw className="h-3 w-3 animate-spin" />
                </Button>
              ) : inCooldown ? (
                <Tooltip>
                  <TooltipTrigger
                    className="ml-1"
                    render={(props) => (
                      <span {...props} className={props.className}>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="pointer-events-none opacity-50"
                          style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}
                          tabIndex={-1}
                        >
                          <Hourglass className="h-3 w-3" />
                        </Button>
                      </span>
                    )}
                  />
                  <TooltipContent side="top">
                    {formatRemainingTime()}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Retry"
                  onClick={(e) => {
                    e.currentTarget.blur()
                    onRetry()
                  }}
                  className="ml-1 opacity-0 hover:opacity-100 focus-visible:opacity-100"
                  style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              )
            )}
          </div>
          {plan && (
            <Badge
              variant="outline"
              className="truncate min-w-0 max-w-[40%]"
              title={plan}
            >
              {plan}
            </Badge>
          )}
        </div>
        {visibleLinks.length > 0 && (
          <div className="mb-2 -mt-0.5 flex flex-wrap gap-1.5">
            {visibleLinks.map((link) => (
              <Button
                key={`${link.label}-${link.url}`}
                variant="outline"
                size="xs"
                className="h-6 max-w-full text-[11px]"
                onClick={() => {
                  openUrl(link.url).catch(console.error)
                }}
              >
                <span className="truncate">{link.label}</span>
                <ExternalLink className="size-3 opacity-70" />
              </Button>
            ))}
          </div>
        )}
        {error && <PluginError message={error} />}

        {loading && !error && (
          <SkeletonLines lines={filteredSkeletonLines} />
        )}

        {!loading && !error && (
          <div className="space-y-4">
            <MetricLineGroups
              lines={groupedLines.ungrouped}
              displayMode={displayMode}
              resetTimerDisplayMode={resetTimerDisplayMode}
              onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
              now={now}
            />

            {groupedLines.groups.map((group) => {
              const contentLines = group.lines.filter((line) => !isErrorBadge(line))
              const errorLines = group.lines.filter(isErrorBadge)
              const hasGroupCard = contentLines.length > 0 || Boolean(group.plan)

              return (
                <div key={`${group.accountLabel}:${group.accountId ?? ""}`} className="space-y-2">
                  {hasGroupCard && (
                    <div className="rounded-md border bg-muted/40 p-2">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        {group.accountId ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={(props) => (
                                <p {...props} className="text-xs text-muted-foreground font-medium truncate">
                                  {group.accountLabel}
                                </p>
                              )}
                            />
                            <TooltipContent side="top" className="text-xs">
                              Account ID: {group.accountId}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <p className="text-xs text-muted-foreground font-medium truncate">
                            {group.accountLabel}
                          </p>
                        )}
                        {group.plan && (
                          <Badge
                            variant="outline"
                            className="truncate min-w-0 max-w-[60%]"
                            title={group.plan}
                          >
                            {group.plan}
                          </Badge>
                        )}
                      </div>
                      <div className="space-y-4">
                        <MetricLineGroups
                          lines={contentLines}
                          displayMode={displayMode}
                          resetTimerDisplayMode={resetTimerDisplayMode}
                          onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
                          now={now}
                        />
                      </div>
                    </div>
                  )}

                  {errorLines.map((line, index) => (
                    <PluginError
                      key={`${group.accountLabel}-error-${index}`}
                      message={line.text}
                      contextLabel={group.accountLabel}
                      contextAccountId={group.accountId}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {showSeparator && <Separator />}
    </div>
  )
}
