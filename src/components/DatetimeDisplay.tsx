"use client";

import dayjs from "dayjs";
import { useEffect, useState } from "react";

function getCurrentTime() {
  return dayjs().format("dddd, MMMM DD • hh:mma");
}

export function DatetimeDisplay() {
  const [time, setTime] = useState(getCurrentTime());

  // update the time every 5 seconds
  //   useEffect(() => {
  //     const interval = setInterval(() => {
  //       setTime(getCurrentTime());
  //     }, 5000);

  //     return () => clearInterval(interval);
  //   }, []);

  return <span>{time}</span>;
}
