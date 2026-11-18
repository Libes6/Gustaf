import { useAtomValue } from "@effect/atom-react";
import type { Subscription, SubscriptionPeriod, SubscriptionPeriodUnit } from "@t3tools/contracts";
import type { UiLanguage } from "@t3tools/contracts/settings";
import {
  daysUntil,
  isChargeReminderDue,
  localCalendarDate,
  nextChargeDate,
  subscriptionTotalsByCurrency,
} from "@t3tools/shared/subscriptions";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";

import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiLanguage } from "../../uiLanguageStore";
import { useT } from "../../useUiLanguage";
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
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  emptySubscriptionDraft,
  parseSubscriptionDraft,
  subscriptionDraft,
  type SubscriptionDraft,
  type SubscriptionDraftField,
} from "./SubscriptionsSettings.logic";

type Translate = ReturnType<typeof useT>;

const UNITS: ReadonlyArray<SubscriptionPeriodUnit> = ["day", "week", "month", "year"];

function formatMoney(language: UiLanguage, amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(language, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatDay(language: UiLanguage, date: string) {
  const instant = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(instant.getTime())
    ? new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(instant)
    : date;
}

function periodLabel(t: Translate, period: SubscriptionPeriod | null) {
  if (period === null) return t("subscriptions.oneTime");
  return period.count === 1
    ? t("subscriptions.every")
        .replace("{count} ", "")
        .replace("{unit}", t(`subscriptions.unitOne.${period.unit}`))
    : t("subscriptions.every")
        .replace("{count}", String(period.count))
        .replace("{unit}", t(`subscriptions.unit.${period.unit}`));
}

export function SubscriptionsSettings() {
  const t = useT();
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <EnvironmentSubscriptions key={environment.environmentId} environment={environment} />
      ) : (
        <SettingsSection {...searchableSetting("subscriptions")} title={t("subscriptions.title")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {t("subscriptions.connectEnvironment")}
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
  const t = useT();
  const language = useUiLanguage();
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
        title={t("subscriptions.title")}
        headerAction={
          canEdit ? (
            <Button size="xs" variant="outline" onClick={() => setDialog({ editing: undefined })}>
              <PlusIcon className="size-3" aria-hidden />
              {t("subscriptions.add")}
            </Button>
          ) : null
        }
      >
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          {t("subscriptions.description").replace("{environment}", environment.label)}
        </p>
        {query.error !== null ? (
          <p className="px-4 py-3 text-sm text-destructive">
            {t("subscriptions.loadFailed").replace("{environment}", environment.label)}
          </p>
        ) : subscriptions.length === 0 ? (
          query.isPending ? null : (
            <SettingsRow
              title={t("subscriptions.emptyTitle")}
              description={t("subscriptions.emptyDescription")}
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
                    <Badge variant="warning">{t("subscriptions.dueSoon")}</Badge>
                  ) : null}
                  {subscription.status._tag === "Cancelled" ? (
                    <Badge variant="secondary">{t("subscriptions.cancelled")}</Badge>
                  ) : null}
                </span>
              }
              description={[
                `${formatMoney(language, subscription.amount, subscription.currency)} · ${periodLabel(t, subscription.period)}`,
                subscription.status._tag === "Cancelled" && subscription.status.activeUntil !== null
                  ? t("subscriptions.cancelledUntil").replace(
                      "{date}",
                      formatDay(language, subscription.status.activeUntil),
                    )
                  : next === null
                    ? t("subscriptions.noNextCharge")
                    : `${t("subscriptions.nextCharge").replace("{date}", formatDay(language, next))} (${
                        daysUntil(next, today) === 0
                          ? t("subscriptions.today")
                          : t("subscriptions.inDays").replace(
                              "{days}",
                              String(daysUntil(next, today)),
                            )
                      })`,
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
                      {t("subscriptions.edit")}
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
        <SettingsSection title={t("subscriptions.totals")}>
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            {t("subscriptions.totalsDescription")}
          </p>
          {totals.map((total) => (
            <SettingsRow
              key={total.currency}
              title={total.currency}
              description={`${t("subscriptions.perMonth").replace(
                "{amount}",
                formatMoney(language, total.monthly, total.currency),
              )} · ${t("subscriptions.perYear").replace(
                "{amount}",
                formatMoney(language, total.yearly, total.currency),
              )}`}
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
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        {t("subscriptions.delete")}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("subscriptions.deleteTitle").replace("{name}", name)}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("subscriptions.deleteDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("subscriptions.cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {t("subscriptions.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const ERROR_KEYS = {
  name: "subscriptions.error.name",
  amount: "subscriptions.error.amount",
  currency: "subscriptions.error.currency",
  periodCount: "subscriptions.error.count",
  anchorDate: "subscriptions.error.date",
  activeUntil: "subscriptions.error.date",
  reminderDaysBefore: "subscriptions.error.reminder",
} as const satisfies Record<SubscriptionDraftField, string>;

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
  const t = useT();
  const upsert = useAtomCommand(serverEnvironment.upsertSubscription);
  const [draft, setDraft] = useState<SubscriptionDraft>(() =>
    editing ? subscriptionDraft(editing) : emptySubscriptionDraft(today),
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const parsed = parseSubscriptionDraft(draft, editing?.id);
  const errorFor = (field: SubscriptionDraftField) =>
    submitted && !parsed.ok && parsed.errors.has(field) ? t(ERROR_KEYS[field]) : undefined;
  const update = (patch: Partial<SubscriptionDraft>) => setDraft({ ...draft, ...patch });
  const providers = useEnvironmentProviders().get(environment.environmentId) ?? [];
  const providerLabels: Record<string, string> = {
    "": t("subscriptions.field.noProvider"),
    ...Object.fromEntries(
      providers.map((provider) => [
        provider.instanceId,
        provider.displayName ?? provider.instanceId,
      ]),
    ),
  };
  const unitLabels = Object.fromEntries(
    UNITS.map((unit) => [unit, t(`subscriptions.unit.${unit}`)]),
  ) as Record<SubscriptionPeriodUnit, string>;

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
    control: React.ReactNode,
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
            {editing
              ? t("subscriptions.editTitle").replace("{name}", editing.name)
              : t("subscriptions.addTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("subscriptions.description").replace("{environment}", environment.label)}
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
              t("subscriptions.field.name"),
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
                t("subscriptions.field.amount"),
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
                t("subscriptions.field.currency"),
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
              <Label htmlFor="subscription-recurring">{t("subscriptions.field.recurring")}</Label>
              <Switch
                id="subscription-recurring"
                checked={draft.recurring}
                onCheckedChange={(recurring) => update({ recurring })}
              />
            </div>
            {draft.recurring ? (
              <div className="grid grid-cols-2 gap-3">
                {field(
                  "subscription-period-count",
                  t("subscriptions.field.every"),
                  <Input
                    id="subscription-period-count"
                    inputMode="numeric"
                    value={draft.periodCount}
                    onChange={(event) => update({ periodCount: event.target.value })}
                    aria-invalid={errorFor("periodCount") !== undefined}
                  />,
                  { error: errorFor("periodCount") },
                )}
                <div className="grid gap-1.5">
                  <Label>&nbsp;</Label>
                  <Select
                    value={draft.periodUnit}
                    items={unitLabels}
                    onValueChange={(value) => {
                      if (value !== null) update({ periodUnit: value });
                    }}
                  >
                    <SelectTrigger aria-label={t("subscriptions.field.every")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {UNITS.map((unit) => (
                        <SelectItem key={unit} value={unit}>
                          {unitLabels[unit]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
            ) : null}
            {field(
              "subscription-anchor",
              t("subscriptions.field.anchorDate"),
              <Input
                id="subscription-anchor"
                type="date"
                value={draft.anchorDate}
                onChange={(event) => update({ anchorDate: event.target.value })}
                aria-invalid={errorFor("anchorDate") !== undefined}
              />,
              { error: errorFor("anchorDate"), hint: t("subscriptions.field.anchorDateHint") },
            )}
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="subscription-cancelled">{t("subscriptions.field.cancelled")}</Label>
              <Switch
                id="subscription-cancelled"
                checked={draft.cancelled}
                onCheckedChange={(cancelled) => update({ cancelled })}
              />
            </div>
            {draft.cancelled
              ? field(
                  "subscription-active-until",
                  t("subscriptions.field.activeUntil"),
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
              t("subscriptions.field.reminder"),
              <Input
                id="subscription-reminder"
                inputMode="numeric"
                value={draft.reminderDaysBefore}
                onChange={(event) => update({ reminderDaysBefore: event.target.value })}
                aria-invalid={errorFor("reminderDaysBefore") !== undefined}
              />,
              {
                error: errorFor("reminderDaysBefore"),
                hint: t("subscriptions.field.reminderHint"),
              },
            )}
            {providers.length > 0 ? (
              <div className="grid gap-1.5">
                <Label>{t("subscriptions.field.provider")}</Label>
                <Select
                  value={draft.providerInstanceId}
                  items={providerLabels}
                  onValueChange={(value) => update({ providerInstanceId: value ?? "" })}
                >
                  <SelectTrigger aria-label={t("subscriptions.field.provider")}>
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
              t("subscriptions.field.paymentMethod"),
              <Input
                id="subscription-payment"
                value={draft.paymentMethodLabel}
                maxLength={60}
                onChange={(event) => update({ paymentMethodLabel: event.target.value })}
              />,
              { hint: t("subscriptions.field.paymentMethodHint") },
            )}
            {field(
              "subscription-note",
              t("subscriptions.field.note"),
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
            {t("subscriptions.cancel")}
          </Button>
          <Button type="submit" form="subscription-form" disabled={saving}>
            {t("subscriptions.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
