import { useAtomValue } from "@effect/atom-react";
import type { Subscription, SubscriptionPeriod, SubscriptionPeriodUnit } from "@t3tools/contracts";
import {
  daysUntil,
  isChargeReminderDue,
  localCalendarDate,
  nextChargeDate,
  subscriptionTotalsByCurrency,
} from "@t3tools/shared/subscriptions";
import { T, useGT, useLocale, Var } from "gt-react";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";

import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  emptySubscriptionDraft,
  parseSubscriptionDraft,
  subscriptionDraft,
  type SubscriptionDraft,
  type SubscriptionDraftField,
} from "./SubscriptionsSettings.logic";

type Translate = ReturnType<typeof useGT>;

const UNITS: ReadonlyArray<SubscriptionPeriodUnit> = ["day", "week", "month", "year"];

function formatMoney(language: string, amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(language, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatDay(language: string, date: string) {
  const instant = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(instant.getTime())
    ? new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(instant)
    : date;
}

function periodLabel(gt: Translate, period: SubscriptionPeriod | null) {
  if (period === null) return gt("one-time", { $context: "subscription billing period" });
  const { count } = period;
  switch (period.unit) {
    case "day":
      return count === 1
        ? gt("every day")
        : gt("{count, plural, one {every {count} day} other {every {count} days}}", { count });
    case "week":
      return count === 1
        ? gt("every week")
        : gt("{count, plural, one {every {count} week} other {every {count} weeks}}", { count });
    case "month":
      return count === 1
        ? gt("every month")
        : gt("{count, plural, one {every {count} month} other {every {count} months}}", {
            count,
          });
    case "year":
      return count === 1
        ? gt("every year")
        : gt("{count, plural, one {every {count} year} other {every {count} years}}", { count });
  }
}

function unitLabels(gt: Translate): Record<SubscriptionPeriodUnit, string> {
  return {
    day: gt("days", { $context: "subscription period unit" }),
    week: gt("weeks", { $context: "subscription period unit" }),
    month: gt("months", { $context: "subscription period unit" }),
    year: gt("years", { $context: "subscription period unit" }),
  };
}

export function SubscriptionsSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <EnvironmentSubscriptions key={environment.environmentId} environment={environment} />
      ) : (
        <SettingsSection {...searchableSetting("subscriptions")} title={gt("Subscriptions")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>Connect an environment to see its subscriptions.</T>
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentSubscriptions({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const gt = useGT();
  const language = useLocale();
  const searchableSetting = useSearchableSetting();
  const environmentId = environment.environmentId;
  const query = useEnvironmentQuery(serverEnvironment.subscriptions({ environmentId, input: {} }));
  const canEdit = useAtomValue(serverEnvironment.upsertSubscription.permissionAtom(environmentId));
  const deleteSubscription = useAtomCommand(serverEnvironment.deleteSubscription);
  const [dialog, setDialog] = useState<null | { readonly editing: Subscription | undefined }>(null);
  const today = localCalendarDate(Date.parse(`${useNowMinute()}:00.000Z`));
  const subscriptions = (query.data?.subscriptions ?? [])
    .map((subscription) => ({ subscription, next: nextChargeDate(subscription, today) }))
    .toSorted(
      (left, right) =>
        (left.next ?? "9999").localeCompare(right.next ?? "9999") ||
        left.subscription.name.localeCompare(right.subscription.name),
    );
  const totals = subscriptionTotalsByCurrency(subscriptions.map((entry) => entry.subscription));

  return (
    <>
      <SettingsSection
        {...searchableSetting("subscriptions")}
        title={gt("Subscriptions")}
        headerAction={
          canEdit ? (
            <Button size="xs" variant="outline" onClick={() => setDialog({ editing: undefined })}>
              <PlusIcon className="size-3" aria-hidden />
              <T>Add subscription</T>
            </Button>
          ) : null
        }
      >
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          <SubscriptionsDescription environmentLabel={environment.label} />
        </p>
        {query.error !== null ? (
          <p className="px-4 py-3 text-sm text-destructive">
            <T>
              Could not load subscriptions from <Var>{environment.label}</Var>.
            </T>
          </p>
        ) : subscriptions.length === 0 ? (
          query.isPending ? null : (
            <SettingsRow
              title={gt("No subscriptions yet")}
              description={gt(
                "Add the services you pay for, such as Claude, ChatGPT, Cursor, or Spotify.",
              )}
            />
          )
        ) : (
          subscriptions.map(({ subscription, next }) => (
            <SettingsRow
              key={subscription.id}
              title={
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 wrap-anywhere">{subscription.name}</span>
                  {isChargeReminderDue(subscription, today) ? (
                    <Badge variant="warning">
                      <T>Due soon</T>
                    </Badge>
                  ) : null}
                  {subscription.status._tag === "Cancelled" ? (
                    <Badge variant="secondary">
                      {gt("Cancelled", { $context: "subscription status" })}
                    </Badge>
                  ) : null}
                </span>
              }
              description={[
                `${formatMoney(language, subscription.amount, subscription.currency)} · ${periodLabel(gt, subscription.period)}`,
                subscription.status._tag === "Cancelled" && subscription.status.activeUntil !== null
                  ? gt("Cancelled, active until {date}", {
                      date: formatDay(language, subscription.status.activeUntil),
                    })
                  : next === null
                    ? gt("No upcoming charge")
                    : nextChargeLabel(gt, formatDay(language, next), daysUntil(next, today)),
                subscription.paymentMethodLabel,
              ]
                .filter(Boolean)
                .join(" · ")}
              control={
                canEdit ? (
                  <div className="flex items-center gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setDialog({ editing: subscription })}
                    >
                      {gt("Edit", { $context: "verb, edits a subscription" })}
                    </Button>
                    <DeleteSubscriptionButton
                      name={subscription.name}
                      onConfirm={async () => {
                        const result = await deleteSubscription({
                          environmentId,
                          input: { id: subscription.id },
                        });
                        if (result._tag === "Success") query.refresh();
                      }}
                    />
                  </div>
                ) : null
              }
            />
          ))
        )}
      </SettingsSection>
      {totals.length > 0 ? (
        <SettingsSection title={gt("Totals")}>
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            <T>Recurring active subscriptions, per currency.</T>
          </p>
          {totals.map((total) => (
            <SettingsRow
              key={total.currency}
              title={total.currency}
              description={gt("{monthly} / month · {yearly} / year", {
                monthly: formatMoney(language, total.monthly, total.currency),
                yearly: formatMoney(language, total.yearly, total.currency),
              })}
            />
          ))}
        </SettingsSection>
      ) : null}
      {dialog !== null && canEdit ? (
        <SubscriptionDialog
          environment={environment}
          editing={dialog.editing}
          today={today}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            query.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function DeleteSubscriptionButton({
  name,
  onConfirm,
}: {
  readonly name: string;
  readonly onConfirm: () => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        {gt("Delete", { $context: "verb, deletes a subscription" })}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Delete {name}?", { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              <T>This removes it from the list on every device.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {gt("Delete", { $context: "verb, deletes a subscription" })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function draftErrorMessage(gt: Translate, field: SubscriptionDraftField) {
  switch (field) {
    case "name":
      return gt("Enter a name.");
    case "amount":
      return gt("Enter an amount of 0 or more.");
    case "currency":
      return gt("Use a three-letter code such as USD.");
    case "periodCount":
      return gt("Enter a whole number of 1 or more.");
    case "anchorDate":
    case "activeUntil":
      return gt("Choose a date.");
    case "reminderDaysBefore":
      return gt("Enter a whole number of 0 or more, or leave it empty.");
  }
}

function SubscriptionDialog({
  environment,
  editing,
  today,
  onClose,
  onSaved,
}: {
  readonly environment: EnvironmentPresentation;
  readonly editing: Subscription | undefined;
  readonly today: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const gt = useGT();
  const upsert = useAtomCommand(serverEnvironment.upsertSubscription);
  const [draft, setDraft] = useState<SubscriptionDraft>(() =>
    editing ? subscriptionDraft(editing) : emptySubscriptionDraft(today),
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const parsed = parseSubscriptionDraft(draft, editing?.id);
  const errorFor = (field: SubscriptionDraftField) =>
    submitted && !parsed.ok && parsed.errors.has(field) ? draftErrorMessage(gt, field) : undefined;
  const update = (patch: Partial<SubscriptionDraft>) => setDraft({ ...draft, ...patch });
  const providers = useEnvironmentProviders().get(environment.environmentId) ?? [];
  const providerLabels: Record<string, string> = {
    "": gt("None", { $context: "no provider selected" }),
    ...Object.fromEntries(
      providers.map((provider) => [
        provider.instanceId,
        provider.displayName ?? provider.instanceId,
      ]),
    ),
  };
  const units = unitLabels(gt);

  const save = async () => {
    setSubmitted(true);
    if (!parsed.ok || saving) return;
    setSaving(true);
    const result = await upsert({ environmentId: environment.environmentId, input: parsed.input });
    setSaving(false);
    if (result._tag === "Success") onSaved();
  };

  const field = (
    id: string,
    label: string,
    control: ReactNode,
    options: { readonly error?: string | undefined; readonly hint?: string } = {},
  ) => (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {control}
      {options.error !== undefined ? (
        <p role="alert" className="text-xs text-destructive">
          {options.error}
        </p>
      ) : options.hint !== undefined ? (
        <p className="text-xs text-muted-foreground">{options.hint}</p>
      ) : null}
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? gt("Edit {name}", { name: editing.name }) : gt("Add subscription")}
          </DialogTitle>
          <DialogDescription>
            <SubscriptionsDescription environmentLabel={environment.label} />
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="subscription-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {field(
              "subscription-name",
              gt("Name", { $context: "subscription name" }),
              <Input
                id="subscription-name"
                value={draft.name}
                maxLength={120}
                onChange={(event) => update({ name: event.target.value })}
                aria-invalid={errorFor("name") !== undefined}
                autoFocus
              />,
              { error: errorFor("name") },
            )}
            <div className="grid grid-cols-2 gap-3">
              {field(
                "subscription-amount",
                gt("Amount"),
                <Input
                  id="subscription-amount"
                  inputMode="decimal"
                  value={draft.amount}
                  onChange={(event) => update({ amount: event.target.value })}
                  aria-invalid={errorFor("amount") !== undefined}
                />,
                { error: errorFor("amount") },
              )}
              {field(
                "subscription-currency",
                gt("Currency"),
                <Input
                  id="subscription-currency"
                  value={draft.currency}
                  maxLength={3}
                  spellCheck={false}
                  onChange={(event) => update({ currency: event.target.value.toUpperCase() })}
                  aria-invalid={errorFor("currency") !== undefined}
                />,
                { error: errorFor("currency") },
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="subscription-recurring">
                <T>Recurring</T>
              </Label>
              <Switch
                id="subscription-recurring"
                checked={draft.recurring}
                onCheckedChange={(recurring) => update({ recurring })}
              />
            </div>
            {draft.recurring
              ? field(
                  "subscription-period-count",
                  gt("Every", { $context: "subscription period, followed by a number" }),
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      id="subscription-period-count"
                      inputMode="numeric"
                      value={draft.periodCount}
                      onChange={(event) => update({ periodCount: event.target.value })}
                      aria-invalid={errorFor("periodCount") !== undefined}
                    />
                    <Select
                      value={draft.periodUnit}
                      items={units}
                      onValueChange={(value) => {
                        if (value !== null) update({ periodUnit: value });
                      }}
                    >
                      <SelectTrigger aria-label={gt("Period unit")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {UNITS.map((unit) => (
                          <SelectItem key={unit} value={unit}>
                            {units[unit]}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>,
                  { error: errorFor("periodCount") },
                )
              : null}
            {field(
              "subscription-anchor",
              gt("A known charge date"),
              <Input
                id="subscription-anchor"
                type="date"
                value={draft.anchorDate}
                onChange={(event) => update({ anchorDate: event.target.value })}
                aria-invalid={errorFor("anchorDate") !== undefined}
              />,
              {
                error: errorFor("anchorDate"),
                hint: gt(
                  "Any past or upcoming charge. Later charges repeat from it; a 31st falls on the month's last day in shorter months.",
                ),
              },
            )}
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="subscription-cancelled">
                {gt("Cancelled", { $context: "subscription status" })}
              </Label>
              <Switch
                id="subscription-cancelled"
                checked={draft.cancelled}
                onCheckedChange={(cancelled) => update({ cancelled })}
              />
            </div>
            {draft.cancelled
              ? field(
                  "subscription-active-until",
                  gt("Active until"),
                  <Input
                    id="subscription-active-until"
                    type="date"
                    value={draft.activeUntil}
                    onChange={(event) => update({ activeUntil: event.target.value })}
                    aria-invalid={errorFor("activeUntil") !== undefined}
                  />,
                  { error: errorFor("activeUntil") },
                )
              : null}
            {field(
              "subscription-reminder",
              gt("Mark as due soon, days before"),
              <Input
                id="subscription-reminder"
                inputMode="numeric"
                value={draft.reminderDaysBefore}
                onChange={(event) => update({ reminderDaysBefore: event.target.value })}
                aria-invalid={errorFor("reminderDaysBefore") !== undefined}
              />,
              {
                error: errorFor("reminderDaysBefore"),
                hint: gt("Leave empty to never mark it."),
              },
            )}
            {providers.length > 0 ? (
              <div className="grid gap-1.5">
                <Label>{gt("Provider")}</Label>
                <Select
                  value={draft.providerInstanceId}
                  items={providerLabels}
                  onValueChange={(value) => update({ providerInstanceId: value ?? "" })}
                >
                  <SelectTrigger aria-label={gt("Provider")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {Object.entries(providerLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            {field(
              "subscription-payment",
              gt("Payment method"),
              <Input
                id="subscription-payment"
                value={draft.paymentMethodLabel}
                maxLength={60}
                onChange={(event) => update({ paymentMethodLabel: event.target.value })}
              />,
              { hint: gt('A label such as "Visa ··1234". Never a card number.') },
            )}
            {field(
              "subscription-note",
              gt("Note"),
              <Textarea
                id="subscription-note"
                value={draft.note}
                maxLength={2000}
                onChange={(event) => update({ note: event.target.value })}
              />,
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button type="submit" form="subscription-form" disabled={saving}>
            <T>Save</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SubscriptionsDescription({ environmentLabel }: { readonly environmentLabel: string }) {
  return (
    <T>
      Everything you pay for, with the next charge. Stored on <Var>{environmentLabel}</Var>, so
      every device connected to it sees the same list.
    </T>
  );
}

function nextChargeLabel(gt: Translate, date: string, days: number) {
  return days === 0
    ? gt("Next charge {date} (today)", { date })
    : gt(
        "{count, plural, one {Next charge {date} (in {count} day)} other {Next charge {date} (in {count} days)}}",
        { date, count: days },
      );
}
