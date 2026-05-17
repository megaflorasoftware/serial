"use client";

import { ViewCategoriesInput, ViewFeedsInput, ViewNameInput } from "./inputs";

interface ContentTabProps {
  name: string;
  setName: (name: string) => void;
  nameInputRef?: React.Ref<HTMLInputElement>;
  selectedCategories: number[];
  setSelectedCategories: (categories: number[]) => void;
  selectedFeedIds: number[];
  setSelectedFeedIds: (feedIds: number[]) => void;
}

export function ContentTab({
  name,
  setName,
  nameInputRef,
  selectedCategories,
  setSelectedCategories,
  selectedFeedIds,
  setSelectedFeedIds,
}: ContentTabProps) {
  return (
    <div className="grid gap-6">
      <ViewNameInput name={name} setName={setName} inputRef={nameInputRef} />
      <ViewFeedsInput
        selectedFeedIds={selectedFeedIds}
        setSelectedFeedIds={setSelectedFeedIds}
      />
      <ViewCategoriesInput
        selectedCategories={selectedCategories}
        setSelectedCategories={setSelectedCategories}
      />
    </div>
  );
}
