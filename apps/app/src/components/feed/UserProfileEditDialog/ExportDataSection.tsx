"use client";

import { DownloadIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { useContentCategories } from "~/lib/data/content-categories";
import { buildViewOPML } from "~/lib/data/export/buildViewOPML";
import { downloadOPML } from "~/lib/data/export/downloadOPML";
import { useFeedCategories } from "~/lib/data/feed-categories";
import { useFeeds } from "~/lib/data/feeds";
import { useViewFeeds } from "~/lib/data/view-feeds";
import { useViews } from "~/lib/data/views";

export function ExportDataSection() {
  const [isExporting, setIsExporting] = useState(false);

  const { feeds } = useFeeds();
  const { views } = useViews();
  const { contentCategories } = useContentCategories();
  const { feedCategories } = useFeedCategories();
  const { viewFeeds } = useViewFeeds();

  const buildExport = () => {
    return buildViewOPML({
      feeds,
      views,
      contentCategories,
      feedCategories,
      viewFeeds,
    });
  };

  const handleExport = () => {
    setIsExporting(true);
    try {
      const opml = buildExport();
      downloadOPML(opml, "serial-feeds.opml");
      toast.success("Exported feeds!");
    } catch {
      toast.error("Failed to export feeds.");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="grid gap-4">
      <Button
        onClick={handleExport}
        disabled={isExporting || feeds.length === 0}
      >
        <DownloadIcon size={16} />
        <span className="pl-1.5">
          {isExporting ? "Exporting..." : "Export OPML"}
        </span>
      </Button>
    </div>
  );
}
