"use client";
import { api } from "~/trpc/react";
import { useKeyboard } from "./KeyboardProvider";
import {
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  Sheet,
} from "./ui/sheet";
import { Button } from "./ui/button";
import { useFeed } from "./FeedProvider";

export function CategoriesSheet() {
  const { setCategory } = useFeed();
  const { isCategoriesOpen } = useKeyboard();
  const { data: categories } = api.contentCategories.getAllForUser.useQuery();

  if (!isCategoriesOpen) return null;

  return (
    <Sheet open={isCategoriesOpen}>
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle>Categories</SheetTitle>
          <SheetDescription>
            <ul>
              <li>
                <Button className="w-full text-left" variant="link">
                  <span className="w-full">Today</span>
                </Button>
              </li>
              {categories.map((category) => (
                <li key={category.id}>
                  <Button className="w-full text-left" variant="link">
                    <span className="w-full">{category.name}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  );
}
