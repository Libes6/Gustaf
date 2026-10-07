import { useId, type ReactNode } from "react";

/**
 * One settings row: title and description on the left, the control on the right. When the window is too narrow for both
 * the control wraps under the text (flex-wrap, see `.setting-row` in theme.css). `id` makes the row a target of settings
 * search (`data-setting`, see lib/settingsIndex.ts). `toggle` renders the standard switch labelled by the title.
 */
export function SettingRow({ id, title, description, toggle, children, stacked, className, testId }: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  toggle?: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean };
  /** The control(s). With `stacked` the control takes the full width under the text (text fields). */
  children?: ReactNode;
  stacked?: boolean;
  className?: string;
  testId?: string;
}) {
  const labelId = useId();
  return (
    <div className={`card-row setting-row${stacked ? " stacked" : ""}${className ? ` ${className}` : ""}`} data-setting={id} data-testid={testId}>
      <div className="grow setting-text">
        <div className="t" id={labelId}>{title}</div>
        {description ? <div className="d">{description}</div> : null}
      </div>
      {(toggle || children) && (
        <div className="setting-control">
          {children}
          {toggle && <button role="switch" aria-checked={toggle.on} aria-labelledby={labelId} disabled={toggle.disabled} className={`toggle${toggle.on ? " on" : ""}`} onClick={() => toggle.onChange(!toggle.on)} />}
        </div>
      )}
    </div>
  );
}

/** A titled block of related rows in one card (title, optional sentence under it). */
export function SettingsSection({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <>
      <h4 aria-level={2}>{title}</h4>
      {description ? <p className="h4-sub">{description}</p> : null}
      <div className="card">{children}</div>
    </>
  );
}
