export const ACCOUNT_LABEL_DELIMITER = " :: "
export const ACCOUNT_META_DELIMITER = " @@ "

export function splitAccountScopedLabel(label: string): {
  accountLabel: string | null
  accountId: string | null
  metricLabel: string
} {
  const index = label.lastIndexOf(ACCOUNT_LABEL_DELIMITER)
  if (index < 0) return { accountLabel: null, accountId: null, metricLabel: label }

  const accountPart = label.slice(0, index).trim()
  const metricLabel = label.slice(index + ACCOUNT_LABEL_DELIMITER.length).trim()
  if (!accountPart || !metricLabel) return { accountLabel: null, accountId: null, metricLabel: label }

  const metaIndex = accountPart.lastIndexOf(ACCOUNT_META_DELIMITER)
  if (metaIndex < 0) return { accountLabel: accountPart, accountId: null, metricLabel }

  const accountLabel = accountPart.slice(0, metaIndex).trim()
  const accountId = accountPart.slice(metaIndex + ACCOUNT_META_DELIMITER.length).trim()
  return { accountLabel: accountLabel || accountPart, accountId: accountId || null, metricLabel }
}

export function getBaseMetricLabel(label: string): string {
  return splitAccountScopedLabel(label).metricLabel
}
