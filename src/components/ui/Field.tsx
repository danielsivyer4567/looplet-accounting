import { cloneElement, isValidElement, useId, type CSSProperties, type ReactElement, type ReactNode } from 'react';

export interface FieldProps {
  label: ReactNode;
  /** The control. A single element gets the label's `id`, `aria-describedby` and `aria-invalid`. */
  children: ReactNode;
  /** Help text under the control. */
  hint?: ReactNode | undefined;
  /** Validation message; also marks the control invalid. */
  error?: ReactNode | undefined;
  required?: boolean | undefined;
  /** Use when the control already has an id (the label then points at it). */
  htmlFor?: string | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

interface ControlProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  required?: boolean;
}

/**
 * A labelled form control with optional hint and error, wired for assistive tech: the label
 * is associated with the control, and the hint and error are read with it.
 */
export function Field({ label, children, hint, error, required, htmlFor, className, style }: FieldProps) {
  const generated = useId();
  const single = isValidElement<ControlProps>(children) ? (children as ReactElement<ControlProps>) : null;
  const controlId = htmlFor ?? single?.props.id ?? generated;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [single?.props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;

  const control = single
    ? cloneElement(single, {
        id: controlId,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true } : {}),
        ...(required && single.props.required === undefined ? { required: true } : {}),
      })
    : children;

  const classes = ['form-group', 'field', error ? 'field-invalid' : '', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={classes} style={style}>
      <label htmlFor={controlId} className="form-label">
        {label}
        {required ? (
          <span className="field-required" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      <div className="field-control">{control}</div>
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
