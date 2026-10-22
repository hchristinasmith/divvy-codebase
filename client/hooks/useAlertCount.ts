// The number of open alerts, shown as the badge on the Overview nav item
// (docs/design/handoff.md "Interactions": nav badge count = open alerts).
//
// Zero until the overview route returns alerts (prd-02 w2). That lane fills
// this body; the shell already reads it and hides the badge at zero.
export function useAlertCount(): number {
  return 0
}
