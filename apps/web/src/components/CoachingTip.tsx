/**
 * First-run coaching tip (RFL.HELP.4): a dismissible note at the top of a
 * view. Dismissals persist per user (lib/coaching.ts); Settings → Help &
 * coaching brings them all back.
 *
 * App provides the user id and the open-Help action through
 * CoachingContext, read once from App's own useAuth(). useAuth is a hook
 * with its own session subscription and workspace lookup, not a context,
 * so calling it per tip would repeat that work and make every tip pop in
 * late.
 *
 * CoachingTipCard is the hook-free render (tested by pressing its buttons
 * without a DOM); CoachingTip adds the context, local state and the
 * collapse on dismiss.
 */
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Lightbulb, X } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { dismiss, isDismissed, type TipId } from "@/lib/coaching";
import { expand, spring } from "@/lib/motion";

export interface CoachingContextValue {
  /** session.user.id when signed in; "preview" in the offline preview. */
  userId: string;
  /** Opens the Help view; null where there is nowhere to go. */
  openHelp: (() => void) | null;
}

export const CoachingContext = createContext<CoachingContextValue>({
  userId: "preview",
  openHelp: null,
});

export function useCoaching(): CoachingContextValue {
  return useContext(CoachingContext);
}

interface CoachingTipProps {
  tipId: TipId;
  title: string;
  /** One or two sentences, under 30 words with the title. */
  children: ReactNode;
}

export function CoachingTip({ tipId, title, children }: CoachingTipProps) {
  const { userId, openHelp } = useCoaching();
  const [hidden, setHidden] = useState(() => isDismissed(userId, tipId));
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence initial={false}>
      {!hidden && (
        <motion.div
          key={tipId}
          {...expand}
          // Collapse the stack gap too, so content below glides up instead
          // of jumping when the tip unmounts.
          exit={{ ...expand.exit, marginTop: 0 }}
          transition={reduceMotion ? { duration: 0 } : spring.expand}
          className="overflow-hidden"
        >
          <CoachingTipCard
            userId={userId}
            tipId={tipId}
            title={title}
            onOpenHelp={openHelp}
            onDismissed={() => setHidden(true)}
          >
            {children}
          </CoachingTipCard>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export interface CoachingTipCardProps extends CoachingTipProps {
  userId: string;
  onOpenHelp: (() => void) | null;
  /** Called after the dismissal is persisted. */
  onDismissed: () => void;
}

export function CoachingTipCard({
  userId,
  tipId,
  title,
  children,
  onOpenHelp,
  onDismissed,
}: CoachingTipCardProps) {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-2xl border border-primary/30 bg-primary/5 py-3 pl-4 pr-2"
    >
      <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5 text-sm">
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">
          {children}
          {onOpenHelp && (
            <>
              {" "}
              <button
                type="button"
                onClick={onOpenHelp}
                className="whitespace-nowrap rounded font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                Learn more →
              </button>
            </>
          )}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="-my-1 h-7 w-7 shrink-0 text-muted-foreground"
        onClick={() => {
          dismiss(userId, tipId);
          onDismissed();
        }}
        title="Dismiss tip"
        aria-label="Dismiss tip"
      >
        <X />
      </Button>
    </div>
  );
}
