"use client";

import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import type { ChartConfig } from "~/components/ui/chart";
import { orpc } from "~/lib/orpc";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "~/components/ui/chart";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

const chartConfig = {
  retentionRate: {
    label: "Retention",
    color: "hsl(var(--chart-3))",
  },
} satisfies ChartConfig;

export function UserRetentionChart() {
  const { data, isLoading } = useQuery(
    orpc.admin.getRetentionStats.queryOptions({ input: {} }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-sans text-base font-medium">
          Monthly Retention Rate
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-muted-foreground flex h-[250px] items-center justify-center">
            Loading...
          </div>
        ) : !data?.stats.length ? (
          <div className="text-muted-foreground flex h-[250px] items-center justify-center">
            No data available
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[250px] w-full">
            <LineChart data={data.stats}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <YAxis
                domain={[0, 100]}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value: number) => `${value}%`}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    hideIndicator
                    formatter={(value, _name, item) => (
                      <div className="flex flex-col gap-0.5">
                        <span>Retention: {value}%</span>
                        <span className="text-muted-foreground text-xs">
                          {item.payload.activeUsers} of{" "}
                          {item.payload.totalUsers} users active
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Line
                dataKey="retentionRate"
                type="monotone"
                stroke="var(--color-retentionRate)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
