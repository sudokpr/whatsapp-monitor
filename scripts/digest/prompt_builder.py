#!/usr/bin/env python3
"""Prompt construction for WhatsApp digest summarization.

DSPy is optional. When DSPy is installed and DSPY_LM_MODEL is configured, this
module asks DSPy to draft the summarizer prompt from the raw digest metadata.
Otherwise it returns deterministic fallback prompts that match the current cron
behavior.
"""
from __future__ import annotations

import os

from input_guardrails import PROMPT_SECURITY_RULES, untrusted_payload


DEFAULT_PROMPT_VERSION = "v2"
SUPPORTED_PROMPT_VERSIONS = {"v1", "v2"}


def _prompt_version() -> str:
    version = os.environ.get("DIGEST_PROMPT_VERSION", DEFAULT_PROMPT_VERSION).strip().lower()
    if version not in SUPPORTED_PROMPT_VERSIONS:
        supported = ", ".join(sorted(SUPPORTED_PROMPT_VERSIONS))
        raise ValueError(f"Unsupported DIGEST_PROMPT_VERSION={version!r}; expected one of: {supported}")
    return version


def _base_rules_v1() -> str:
    return f"""{PROMPT_SECURITY_RULES}

Output only the digest content. Do not say "Here is", "ready to send", or any other preamble.
Use plain text only: no markdown bold, no markdown tables.
Preserve conversation headings for meaningful new messages.
Use previous-window context only to explain replies and references; do not report it as new activity.
When a message is marked as "reply to previous message", summarize the response together with what it replied to when that context changes the meaning.
Keep every concrete event, request, buy/sell listing, plan, registration link, DM update, and newsletter/news item that matters.
For newsletter/news-feed conversations, include distinct updates line by line in chronological order unless duplicated.
For buy/sell or requests, include item, ask/sale status, price/contact if present, and whether it was wanted or offered.
Treat vehicle/model names like RS457, CB350, A50, or 90/90-19 as names/specs, not prices.
Only treat a value as a price when the message explicitly uses price wording, rupee symbols, Rs, INR, or k/lakh notation in a sale context.
Deduplicate repeated cross-posted events, but preserve unique dates, contacts, prices, locations, links, and actions.
When a message includes a [photo: URL], [video: URL], or other media marker, mention that the caption had attached media if the visual context is needed.
Skip filler, acknowledgements, repeated context, and generic chat.
End with "Next actions:" only if there is something actionable; do not leave an empty action section."""


def _base_rules_v2() -> str:
    return f"""{PROMPT_SECURITY_RULES}

Output only the digest content. Do not say "Here is", "ready to send", or any other preamble.
Use compact plain text only: no markdown bold and no markdown tables.
Use only the length the important activity requires. For busy windows, target 1,200-1,500 characters; quiet windows should be much shorter. Never exceed 1,800 characters.
Prioritize decisions, confirmed plans or changes, deadlines, incidents, direct requests, questions awaiting answers, registrations, and useful buy/sell details.
Preserve exact dates, times, prices, locations, contacts, and links only when they support an important update or action.
Combine duplicates and related messages into one bullet. Do not summarize every conversation merely because it was active.
Collapse low-priority but meaningful activity into one "Other activity" bullet; omit filler, acknowledgements, generic chat, repeated promotions, and routine feed items.
Use previous-window context only to explain new replies or references. Never present context as new activity.
When a message is marked as "reply to previous message", include the referenced meaning only when needed to understand the new response.
Treat vehicle/model names like RS457, CB350, A50, or 90/90-19 as names/specs, not prices.
Only treat a value as a price when the message explicitly uses price wording, rupee symbols, Rs, INR, or k/lakh notation in a sale context.
Mention attached media only when it materially affects the update. Do not create a link or media appendix.
Use "Needs attention" only for concrete actions, unanswered requests, or imminent deadlines. Omit the section when empty.
Use "Key updates" for the remaining high-value information. Limit the entire digest to 8 bullets, ordered by importance.
Use "Other activity" only when it helps convey omitted meaningful activity, and limit it to one bullet."""


def _static_main_prompt_v1(raw_digest: str) -> str:
    return f"""You are summarising WhatsApp community conversations into a plain-text digest.
The raw digest below contains only new messages since the last successful digest run, grouped by conversation name, with timestamps, WhatsApp profile names when available, fallback sender labels, and text. Messages may include an explicit "reply to previous message" annotation before the new text. Auto-Strava noise is mostly filtered.
Some active groups may include a clearly marked previous-window context section. Use that context only to understand replies and references; do not report it as new activity unless it is directly needed to explain a new message.
Write a detailed but readable plain-text digest for someone who was offline.

Structure:
- Start with a 1-2 line overall summary of the most important activity across all conversations.
- Then cover each active conversation separately under its own heading line.
- For interactive groups and normal DMs, mention who said what that matters, decisions, plans, events, registrations, incidents, requests, and follow-ups.
- For newsletter or news-feed style conversations, list important updates chronologically with concrete subjects.

Rules:
{_base_rules_v1()}

RAW DIGEST:
{untrusted_payload("whatsapp_digest", raw_digest)}"""


def _static_chunk_prompt_v1(raw_digest_chunk: str, chunk_number: int, chunk_count: int) -> str:
    return f"""You are summarising one chunk of a larger WhatsApp plain-text digest.
This is chunk {chunk_number} of {chunk_count}. Summarise only the conversations present in this chunk.

Rules:
{_base_rules_v1()}
Keep the output compact, but prefer completeness over being too short.

RAW DIGEST CHUNK:
{untrusted_payload("whatsapp_digest_chunk", raw_digest_chunk)}"""


def _static_merge_prompt_v1(chunk_summaries: str) -> str:
    return f"""You are merging partial summaries from a chunked WhatsApp digest.
Write one final plain-text digest.

Rules:
{_base_rules_v1()}
Start with a 1-2 line overall summary.
Use conversation headings from the partial summaries. Keep names like "Rides 2 ( Full )" and "BLR Cyclists Buy/Sell requests".
If the same conversation heading appears in multiple partial summaries, merge it into one section.
Do not repeat the same event, debate, rule, sale item, or action just because it appeared in multiple chunks.
Write one consolidated "Next actions:" line at the end only when there are concrete actions.
Do not invent broad category headings like "Personal Updates", "India and Global News", or "Motorcycling and Cycling".
Do not editorialize or compare importance unless the messages explicitly do that.

PARTIAL SUMMARIES:
{untrusted_payload("model_chunk_summaries", chunk_summaries)}"""


def _static_main_prompt_v2(raw_digest: str) -> str:
    return f"""You are summarising WhatsApp community conversations into a short, prioritized briefing for someone who was offline.
The raw digest contains new messages grouped by conversation. Some groups may also contain clearly marked previous-window context.

Required structure:
- Begin with: "WhatsApp brief: <one sentence describing the most important activity>."
- Then use up to three headings in this order: "Needs attention", "Key updates", and "Other activity".
- Put one compact bullet per distinct subject below a heading.
- Do not include conversation-by-conversation sections. Name a conversation inside a bullet only when it provides useful context.

Rules:
{_base_rules_v2()}

RAW DIGEST:
{untrusted_payload("whatsapp_digest", raw_digest)}"""


def _static_chunk_prompt_v2(raw_digest_chunk: str, chunk_number: int, chunk_count: int) -> str:
    return f"""You are extracting only high-value activity from chunk {chunk_number} of {chunk_count} of a WhatsApp digest.
Return compact candidate bullets for a later merge. Do not write an introduction or try to cover every conversation.

Rules:
{_base_rules_v2()}
Limit this chunk to 6 candidate bullets, ordered by importance.

RAW DIGEST CHUNK:
{untrusted_payload("whatsapp_digest_chunk", raw_digest_chunk)}"""


def _static_merge_prompt_v2(chunk_summaries: str) -> str:
    return f"""You are merging candidate updates from chunks of one WhatsApp digest into a short, prioritized briefing.

Required structure:
- Begin with: "WhatsApp brief: <one sentence describing the most important activity>."
- Then use up to three headings in this order: "Needs attention", "Key updates", and "Other activity".
- Put one compact bullet per distinct subject below a heading.

Rules:
{_base_rules_v2()}
Deduplicate aggressively across chunks and keep only the 8 most useful bullets overall.

PARTIAL SUMMARIES:
{untrusted_payload("model_chunk_summaries", chunk_summaries)}"""


def _dspy_prompt(task: str, payload: str, fallback: str, rules: str, **metadata: object) -> str:
    mode = os.environ.get("DSPY_PROMPT_MODE", "auto").strip().lower()
    lm_model = os.environ.get("DSPY_LM_MODEL", "").strip()
    if mode == "static" or not lm_model:
        return fallback

    try:
        import dspy  # type: ignore
    except Exception:
        return fallback

    try:
        lm_kwargs = {}
        api_base = os.environ.get("DSPY_LM_API_BASE", "").strip()
        if api_base:
            lm_kwargs["api_base"] = api_base
        dspy.configure(lm=dspy.LM(lm_model, **lm_kwargs))

        class WhatsAppPromptSpec(dspy.Signature):
            """Create a prompt for an LLM that summarizes WhatsApp digests as plain text."""

            task: str = dspy.InputField()
            rules: str = dspy.InputField()
            metadata: str = dspy.InputField()
            prompt: str = dspy.OutputField(
                desc="A concise instruction prompt. It must end with a RAW DIGEST or PARTIAL SUMMARIES placeholder."
            )

        predictor = dspy.Predict(WhatsAppPromptSpec)
        result = predictor(task=task, rules=rules, metadata=str(metadata))
        prompt = str(getattr(result, "prompt", "")).strip()
        if not prompt:
            return fallback
        if "{payload}" in prompt:
            prompt = prompt.replace("{payload}", "")
        return f"{PROMPT_SECURITY_RULES}\n\n{prompt}\n\nUNTRUSTED INPUT:\n{payload}"
    except Exception:
        return fallback


def build_prompt(raw_digest: str) -> str:
    version = _prompt_version()
    rules = _base_rules_v1() if version == "v1" else _base_rules_v2()
    fallback = (
        _static_main_prompt_v1(raw_digest)
        if version == "v1"
        else _static_main_prompt_v2(raw_digest)
    )
    return _dspy_prompt(
        f"Summarize a full WhatsApp digest using prompt version {version}.",
        untrusted_payload("whatsapp_digest", raw_digest),
        fallback,
        rules,
        prompt_version=version,
        kind="full",
        raw_digest_chars=len(raw_digest),
    )


def build_chunk_prompt(raw_digest_chunk: str, chunk_number: int, chunk_count: int) -> str:
    version = _prompt_version()
    rules = _base_rules_v1() if version == "v1" else _base_rules_v2()
    fallback = (
        _static_chunk_prompt_v1(raw_digest_chunk, chunk_number, chunk_count)
        if version == "v1"
        else _static_chunk_prompt_v2(raw_digest_chunk, chunk_number, chunk_count)
    )
    return _dspy_prompt(
        f"Summarize one chunk of a larger WhatsApp digest using prompt version {version}.",
        untrusted_payload("whatsapp_digest_chunk", raw_digest_chunk),
        fallback,
        rules,
        prompt_version=version,
        kind="chunk",
        chunk_number=chunk_number,
        chunk_count=chunk_count,
        raw_digest_chars=len(raw_digest_chunk),
    )


def build_merge_prompt(chunk_summaries: str) -> str:
    version = _prompt_version()
    rules = _base_rules_v1() if version == "v1" else _base_rules_v2()
    fallback = (
        _static_merge_prompt_v1(chunk_summaries)
        if version == "v1"
        else _static_merge_prompt_v2(chunk_summaries)
    )
    return _dspy_prompt(
        f"Merge partial WhatsApp digest summaries using prompt version {version}.",
        untrusted_payload("model_chunk_summaries", chunk_summaries),
        fallback,
        rules,
        prompt_version=version,
        kind="merge",
        summary_chars=len(chunk_summaries),
    )


def build_model_comparison_prompt(model_summaries: list[tuple[str, str]], reference_digest: str) -> str:
    formatted = []
    for label, summary in model_summaries:
        formatted.append(f"MODEL: {label}\nSUMMARY:\n{summary}")
    joined = "\n\n---\n\n".join(formatted)
    return f"""You are comparing multiple model-generated WhatsApp digest summaries for the same raw message window.
Use the reference raw digest as the source of truth. Write a concise plain-text comparison for the user.

{PROMPT_SECURITY_RULES}

Rules:
- Output only the comparison. Do not include a preamble like "Here is".
- Start with one verdict line naming the strongest summary and why, judged against the reference raw digest.
- Then list 3-6 concrete differences in coverage, accuracy, usefulness, structure, or actionability.
- Mention notable omissions, incorrect claims, or hallucination risk when visible from the reference digest.
- Prefer evidence from the reference digest over model phrasing.
- Keep it factual and compact.
- Do not use markdown tables.

REFERENCE RAW DIGEST:
{untrusted_payload("reference_whatsapp_digest", reference_digest)}

SUMMARIES:
{untrusted_payload("model_summaries", joined)}"""
