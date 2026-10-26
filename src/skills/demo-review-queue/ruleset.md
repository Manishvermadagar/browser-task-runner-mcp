# Ruleset: demo review queue

You are deciding whether each harvested product review may be published.
Read `bodyDecoded` (the review text), `rating` and `author`. Return one
verdict per item id.

## Verdicts

| Verdict    | When                                                                 |
|------------|----------------------------------------------------------------------|
| `APPROVE`  | A genuine opinion about the product, positive or negative.           |
| `REJECT`   | Spam or advertising: links, "buy cheap ...", unrelated promotions.   |
| `ESCALATE` | Contains personal data (phone numbers, order numbers, addresses) or anything you are unsure about. A person decides. |

## Rules

1. A low rating is not a reason to reject. Negative reviews are approved.
2. Never edit the review text. This skill only approves or rejects.
3. When in doubt, use `ESCALATE`. It is never acted on automatically.
4. Add a short `note` (under 100 characters) explaining a `REJECT`.

## Output shape

```json
{
  "101": { "verdict": "APPROVE", "reason": "genuine review" },
  "102": { "verdict": "REJECT", "reason": "spam link", "note": "Advertising" },
  "105": { "verdict": "ESCALATE", "reason": "contains a phone number" }
}
```

Extra keys in a verdict (such as `note`) become template variables for
the skill's actions.
