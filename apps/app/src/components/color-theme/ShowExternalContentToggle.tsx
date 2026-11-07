import { Label } from "../ui/label";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { useFlagState } from "~/lib/hooks/useFlagState";

export const ShowExternalContentToggle = () => {
  const [externalContent, setExternalContent] = useFlagState(
    "ARTICLE_EXTERNAL_CONTENT",
  );

  return (
    <div className="mt-2">
      <Label
        htmlFor="show-external-content-select"
        className="mb-2 block font-semibold"
      >
        Show external content
      </Label>
      <ToggleGroup
        id="show-external-content-select"
        type="single"
        size="sm"
        value={externalContent}
        onValueChange={(value) => {
          if (value === "show" || value === "hide") setExternalContent(value);
        }}
      >
        <ToggleGroupItem className="w-full" value="show">
          Show
        </ToggleGroupItem>
        <ToggleGroupItem className="w-full" value="hide">
          Hide
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
};
