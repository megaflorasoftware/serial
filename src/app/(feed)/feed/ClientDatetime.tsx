"use client";

import dayjs from "dayjs";

export function ClientDatetime() {
  return dayjs().format("dddd, MMMM DD • hh:mma");
}
