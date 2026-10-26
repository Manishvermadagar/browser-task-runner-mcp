# Notes: demo-review-queue

Target: the local demo app in `demo/server.js` (`node demo/server.js`,
http://127.0.0.1:8790). All state is in memory; restart the app or
`POST /reset` to start over.

## Endpoints the skill uses

- Read: `GET /items/{id}`, server-rendered HTML.
  - `data-item-id` on `<main>` is the identity guard: the engine refuses
    to act if the page shows a different item from the one requested.
  - `data-status` drives the precondition (`actOnlyWhen`: only pending
    items are acted on) and the verify step.
  - The review text sits in `<blockquote id="review-body">`. It is the
    `contentField`, so if the text changes between review and action the
    item is skipped as STALE.
  - The CSRF token is a hidden `<input name="csrf">`. It is only present
    while the item is pending.
- Approve: `POST /items/{id}/approve`, form fields `csrf`, `note`.
- Reject: `POST /items/{id}/reject`, form fields `csrf`, `note`.
- List: `GET /api/items?status=pending`, JSON `{ items: [...] }`.

## Things the demo deliberately exercises

- Item 104 contains `&`, so its raw and decoded body differ.
- Item 105 contains personal data and should be escalated, which the
  engine never acts on.
- Acting on an already-decided item returns HTTP 409; the precondition
  catches it before any write is attempted.
