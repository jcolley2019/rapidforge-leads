import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface StubViewProps {
  title: string;
  description: string;
  sprint: string;
  children?: ReactNode;
}

/** Placeholder body for views that land in later sprints (PRD 7.3). */
export function StubView({
  title,
  description,
  sprint,
  children,
}: StubViewProps) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-primary">
          {sprint}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Coming soon</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {children ? <CardContent>{children}</CardContent> : null}
      </Card>
    </div>
  );
}
