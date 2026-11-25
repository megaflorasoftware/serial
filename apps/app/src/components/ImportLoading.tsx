import { Loader2Icon } from "lucide-react";
import { Progress } from "~/components/ui/progress";
import { useLoadingMode } from "~/lib/data/loading-machine";
import {
  twoStageProgressLabel,
  twoStageProgressPercent,
} from "~/lib/two-stage-progress";

export function ImportLoading() {
  const loading = useLoadingMode();

  const importing = loading.mode === "importing" ? loading : null;

  return (
    <div className="bg-background fixed inset-0 flex h-screen w-screen flex-col items-center justify-center">
      {importing?.importProgress.total ? (
        <>
          <Progress
            value={twoStageProgressPercent(importing.importProgress)}
            className="w-48"
          />
          <p className="text-muted-foreground pt-4 font-sans text-sm">
            {twoStageProgressLabel(importing.importProgress)}
          </p>
          {importing.errors > 0 && (
            <p className="text-muted-foreground/50 pt-2 font-sans text-sm">
              {importing.errors} feed{importing.errors !== 1 ? "s" : ""} failed
              to import
            </p>
          )}
        </>
      ) : (
        <Loader2Icon size={32} className="animate-spin" />
      )}
    </div>
  );
}
