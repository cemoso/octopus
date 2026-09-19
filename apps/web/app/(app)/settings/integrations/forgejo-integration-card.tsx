"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconGitFork } from "@tabler/icons-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { connectForgejo, disconnectForgejo, syncForgejo } from "./actions";

type ForgejoData = {
  id: string;
  forgejoHost: string;
  username: string;
  webhookSecret?: string;
} | null;

export function ForgejoIntegrationCard({ data, canManage, appUrl }: {
  data: ForgejoData;
  canManage: boolean;
  appUrl: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const [host, setHost] = useState(data?.forgejoHost ?? "");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [origin, setOrigin] = useState(appUrl ?? "");
  useEffect(() => { if (!appUrl) setOrigin(window.location.origin); }, [appUrl]);
  const webhookUrl = data && origin ? `${origin.replace(/\/$/, "")}/api/forgejo/webhook/${data.id}` : "";

  function run(action: () => Promise<{ error?: string; synced?: number }>, onSuccess?: () => void) {
    if (busy.current) return;
    busy.current = true;
    setError("");
    setMessage("");
    startTransition(async () => {
      try {
        const result = await action();
        if (result.error) setError(result.error);
        else {
          onSuccess?.();
          if (result.synced !== undefined) setMessage(`${result.synced} repositories synced. Configure a webhook on each repository to start automatic reviews.`);
          else setMessage("Forgejo disconnected. Remove the Octopus webhooks and revoke its token in Forgejo.");
        }
        router.refresh();
      } catch {
        setError("The request failed. Please try again.");
      } finally {
        busy.current = false;
      }
    });
  }

  return (
    <Card id="forgejo" className="scroll-mt-6">
      <CardHeader>
        <div className="flex items-center gap-2">
          <IconGitFork className="size-5 text-orange-500" />
          <CardTitle>Forgejo</CardTitle>
          {data && <Badge variant="outline">Connected</Badge>}
        </div>
        <CardDescription>Review pull requests on your self-hosted Forgejo instance.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Use an HTTPS instance and a dedicated account with repository admin access.
          Create a personal access token in Forgejo Settings → Applications with{" "}
          <code>read:user</code>, <code>write:repository</code> and <code>write:issue</code> scopes.
          Repository write access lets Octopus post reviews and commit statuses.
        </p>
        <p className="text-muted-foreground text-xs">Octopus Cloud connects to public HTTPS instances. For a private HTTPS instance, your self-hosted Octopus operator must enable access first.</p>
        <a className="text-primary text-sm underline underline-offset-4" href="/docs/integrations#forgejo">Forgejo setup guide</a>
        {data && <p className="break-all text-sm">{data.username} · {data.forgejoHost}</p>}
        {!canManage ? <p className="text-muted-foreground text-sm">An organization owner or admin can manage this connection.</p> : (
          <>
            <details open={!data}>
              <summary className="cursor-pointer text-sm font-medium">{data ? "Replace access token" : "Connect your instance"}</summary>
              <form className="mt-3 space-y-3" onSubmit={(event) => {
                event.preventDefault();
                const formData = new FormData(event.currentTarget);
                run(() => connectForgejo(formData), () => setToken(""));
              }}>
                <div className="space-y-1.5">
                  <Label htmlFor="forgejo-host">Forgejo instance URL</Label>
                  <Input id="forgejo-host" name="host" type="url" placeholder="https://forgejo.example.com" value={data?.forgejoHost ?? host} onChange={(event) => setHost(event.target.value)} readOnly={!!data || pending} required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="forgejo-token">Personal access token</Label>
                  <Input id="forgejo-token" name="token" type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} readOnly={pending} maxLength={4096} required />
                </div>
                <p className="text-muted-foreground text-xs">One instance per organization. Only repositories this account administers are synced.</p>
                <Button type="submit" disabled={pending}>{pending ? "Working…" : data ? "Replace token and sync" : "Connect Forgejo"}</Button>
              </form>
            </details>
            {data && data.webhookSecret && (
              <div className="border-border space-y-3 rounded-md border p-4">
                <p className="text-sm font-medium">Set up automatic reviews</p>
                <p className="text-muted-foreground text-sm">In each synced repository, open Settings → Webhooks → Add Webhook → Forgejo. Use POST, application/json, the URL and secret below, and select Pull Request events. Keep the webhook active.</p>
                <p className="text-muted-foreground text-xs">Also select Issue Comment events to request reviews with <code>@octopus</code> or <code>/octopus</code> in pull request comments.</p>
                <div className="space-y-1.5">
                  <Label htmlFor="forgejo-webhook-url">Target URL</Label>
                  <Input id="forgejo-webhook-url" value={webhookUrl} readOnly onFocus={(event) => event.target.select()} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="forgejo-webhook-secret">Webhook secret</Label>
                  <Input id="forgejo-webhook-secret" value={data.webhookSecret} readOnly onFocus={(event) => event.target.select()} />
                </div>
                <p className="text-muted-foreground text-xs">Open or update a pull request after saving the webhook to trigger its first review.</p>
              </div>
            )}
            {data && <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={pending} onClick={() => run(syncForgejo)}>Sync repositories</Button>
              <Button variant="outline" disabled={pending} onClick={() => {
                if (window.confirm("Disconnect Forgejo and deactivate its repositories? Existing review history is kept. Remove the webhooks and revoke the token in Forgejo afterward.")) run(disconnectForgejo);
              }}>Disconnect</Button>
            </div>}
          </>
        )}
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        {message && <p role="status" className="text-muted-foreground text-sm">{message}</p>}
      </CardContent>
    </Card>
  );
}
