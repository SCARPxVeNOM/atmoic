import { FC } from "react";

interface Props {
  /** Collateral type of the position. */
  collateralType: string;
  /** Whether position is currently unhealthy. */
  unhealthy: boolean;
  /** Timestamp when position became unhealthy (ms). Null if healthy. */
  unhealthySince: number | null;
}

const GRACE_MS = 2 * 60 * 60 * 1000; // 2 hours

export const GracePeriodBadge: FC<Props> = ({
  collateralType,
  unhealthy,
  unhealthySince,
}) => {
  // Only JLP positions have grace period
  if (collateralType !== "JLP" || !unhealthy || !unhealthySince) return null;

  const elapsed = Date.now() - unhealthySince;
  const remaining = Math.max(0, GRACE_MS - elapsed);
  const remainingMin = Math.ceil(remaining / 60_000);
  const elapsedMin = Math.floor(elapsed / 60_000);
  const urgent = remaining < 15 * 60_000; // <15 min

  return (
    <div className={`rounded-lg px-3 py-2 text-xs ${
      urgent ? "bg-red-900/50 border border-red-500/50 animate-pulse" : "bg-yellow-900/30 border border-yellow-600/30"
    }`}>
      <div className="font-medium">
        {urgent ? "Liquidation imminent" : "Grace period active"}
      </div>
      <div className="text-slate-400 mt-0.5">
        Unhealthy for {elapsedMin} min
        {remaining > 0
          ? ` — ${remainingMin} min buffer remaining`
          : " — grace period expired"}
      </div>
    </div>
  );
};
