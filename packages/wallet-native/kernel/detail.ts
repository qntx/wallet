/**
 * A `"<domain>:<code>"` diagnostic a platform reports alongside a failure code (e.g.
 * `"LAErrorDomain:-5"`, `"android:KeyPermanentlyInvalidatedException"`): kept only when it is a
 * short token string — anything else (oversize, free text) is dropped at this producer boundary,
 * never rejected. Never carries userInfo, localized text or input.
 */
export function detailOf(detail: string | undefined): string | undefined {
  return detail !== undefined && detail.length <= 80 && /^[A-Za-z0-9_.:-]+$/.test(detail)
    ? detail
    : undefined;
}
