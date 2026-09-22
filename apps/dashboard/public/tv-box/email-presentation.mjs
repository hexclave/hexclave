/**
 * Legacy `sent` includes failed attempts; contract 3 separates successful sends
 * from failures. SMTP acceptance is not a delivery receipt in either contract.
 * Both TV renderers share this distinction and the older-server fallback.
 * @param {{ sent: number, assessableSends: number, deliveryRatePercent: number | null, sendActivity?: { sent: number, failed: number } }} data
 */
export function getTvEmailPresentation(data) {
  const hasNoOutcomes = (data.sendActivity?.sent ?? data.sent) > 0 && data.assessableSends === 0;
  return {
    volumeLabel: data.sendActivity == null ? "Completed send attempts · 7d" : "Emails sent · 7d",
    volumeValue: (data.sendActivity?.sent ?? data.sent).toLocaleString(),
    volumeDetail: data.sendActivity == null
      ? "Includes successful sends and failed attempts"
      : data.sendActivity.sent === 0
        ? "No successful sends in this window"
        : "Accepted by mail server; delivery may be unconfirmed",
    rateValue: data.deliveryRatePercent == null
      ? hasNoOutcomes ? "No delivery data" : "Insufficient data"
      : `${data.deliveryRatePercent}%`,
    rateDetail: hasNoOutcomes
      ? "Send activity recorded; delivery receipts unavailable"
      : data.deliveryRatePercent == null
        ? "At least 20 confirmed outcomes required"
        : `${data.assessableSends.toLocaleString()} confirmed outcomes`,
    chartTitle: data.sendActivity == null ? "Delivery Outcomes & Queue" : "Email Sending Activity",
    chartSubtitle: data.sendActivity == null
      ? "Daily status · trailing 7 days · excludes unconfirmed sends"
      : "Sent and failed by send date · queue by creation date · UTC",
  };
}
