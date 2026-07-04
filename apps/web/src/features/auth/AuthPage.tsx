import { Loader2, Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/lib/supabase";

/**
 * Supabase auth: email magic link + Google OAuth (PRD 3.1).
 * Functional as soon as Joey supplies VITE_SUPABASE_URL / ANON_KEY and
 * enables the providers in the Supabase dashboard.
 */
export function AuthPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!supabase) return null; // App only renders AuthPage when configured

  const client = supabase;

  async function sendMagicLink(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const { error: otpError } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (otpError) setError(otpError.message);
    else setMessage(`Magic link sent to ${email} — check your inbox.`);
  }

  async function signInWithGoogle(): Promise<void> {
    setBusy(true);
    setError(null);
    const { error: oauthError } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (oauthError) {
      setBusy(false);
      setError(oauthError.message);
    }
    // On success the browser redirects to Google.
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-2 text-center">
          <div className="mx-auto flex items-center gap-2">
            <span className="h-3 w-3 rounded-sm bg-primary" aria-hidden />
            <span className="text-lg font-semibold tracking-tight">
              RapidForge
            </span>
          </div>
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>
            Multi-agent local lead generation
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={sendMagicLink} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy || !email}>
              {busy ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Mail />
              )}
              Send magic link
            </Button>
          </form>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs uppercase text-muted-foreground">or</span>
            <Separator className="flex-1" />
          </div>

          <Button
            variant="outline"
            className="w-full"
            onClick={() => void signInWithGoogle()}
            disabled={busy}
          >
            Continue with Google
          </Button>

          {message && (
            <p className="text-sm text-agent-complete" role="status">
              {message}
            </p>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
