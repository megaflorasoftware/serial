"use client";

import dayjs from "dayjs";
import { useState } from "react";
import { useFeed } from "./FeedProvider";

function getCurrentTime() {
  return dayjs().format("dddd, MMMM DD • hh:mma");
}

export function DatetimeDisplay() {
  const { selectedItem } = useFeed();
  const [time] = useState(getCurrentTime());

  if (!!selectedItem) {
    return (
      <div className="flex flex-col items-center text-center">
        <span className="text-xs sm:text-sm">{selectedItem.title}</span>
        <span className="hidden text-xs sm:block">{selectedItem.author}</span>
      </div>
    );
  }

  return <span className="block text-center text-xs sm:text-sm">{time}</span>;
}
