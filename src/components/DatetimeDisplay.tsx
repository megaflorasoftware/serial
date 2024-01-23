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

  // update the time every 5 seconds
  //   useEffect(() => {
  //     const interval = setInterval(() => {
  //       setTime(getCurrentTime());
  //     }, 5000);

  //     return () => clearInterval(interval);
  //   }, []);

  if (!!selectedItem) {
    return (
      <div className="flex flex-col items-center text-center">
        <span>{selectedItem.title}</span>
        <span className="text-xs">{selectedItem.author}</span>
      </div>
    );
  }

  return <span>{time}</span>;
}
