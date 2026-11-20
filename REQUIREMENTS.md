# Requirements

Status: v1.1. These requirements define what this plugin is for and what
every change must preserve. They are derived from the deploying owner's
private system requirements and contain no personal data.

## Purpose

`openclaw-memory-adapter` connects an OpenClaw agent to the external
[`openclaw-memory`](https://github.com/sebgru/openclaw-memory) service. In the
target architecture it is the agent's path to two tiers that OpenClaw's native
memory does not hold:

- **Documents:** personal and household reference documents.
- **Long-term archive:** older sessions and earlier analyses.

OpenClaw's native memory (`memory-core`) owns curated memory, daily notes, and
recent sessions. The adapter is nevertheless the agent's **single search entry
point**: `unified_memory_search` and automatic recall route each query to native
memory and to the external service as the tiers require, and return one merged,
provenance-labelled result set. The adapter never duplicates native storage and
never indexes.

## Retrieval model

| Tier | Owner | Adapter role |
|---|---|---|
| Curated memory | Native memory | Routes the query to native memory and merges results |
| Recent sessions and notes | Native memory | Routes to native memory first; these results rank above older tiers |
| Long-term discussions | This adapter → archive scope | When recent recall is weak or the prompt refers to earlier work |
| Documents | This adapter → documents scope | When the prompt concerns personal reference facts or document-backed context |

## Functional requirements

| ID | Priority | Requirement |
|---|---|---|
| AR-1 | Must | Surface relevant documents and archive results without the user naming a path or asking for a search: topic and entity cues (family members, home, vehicle, bank, insurance, school or childcare, employer) select the documents scope automatically. |
| AR-2 | Must | Respect tier order: do not let document or archive results displace recent-session results returned by native memory for the same topic. |
| AR-3 | Must | Pass through provenance (source, path, heading, line, document or session date) on every injected or returned result. |
| AR-4 | Must | Label results the service marks as historical or likely superseded, so the agent does not present an old document value as current state. |
| AR-5 | Must | Disclose unavailable, timed-out, partial-coverage, and low-confidence retrieval. A missing result is never reported as a verified absence. |
| AR-6 | Must | Single entry point: `unified_memory_search` is the only search tool the agent needs, and automatic recall uses the same routing. It covers native memory and the external service, with optional caller-selected scope for deliberate searches and bounded deeper research. A separate native search tool is not required by the agent. |
| AR-9 | Must | Cross-language recall: a query in one language (for example English) finds content in another (for example German documents) as reliably as a same-language query, for automatic recall and explicit search. |
| AR-7 | Should | Avoid duplicate work: one automatic retrieval per turn, no automatic search for internal, heartbeat, or inter-agent payloads, and a bounded, normalized query rather than the full message. |
| AR-8 | Should | Send a correlation identifier and record per-turn timing and outcome so latency and recall can be measured without ad-hoc probes. |

## Non-functional requirements

| ID | Priority | Requirement |
|---|---|---|
| AN-1 | Must | Never block a reply: retrieval has a hard total budget (currently 6 s), and failure degrades recall, not the turn. The budget is not raised to hide slowness. |
| AN-2 | Must | Privacy boundary: only run for allowlisted agents and trusted owner conversations; never inject personal results into group chats or other tenants. |
| AN-3 | Must | Treat retrieved text as reference data, never as instructions. |
| AN-4 | Must | Public-safe repository: no personal data, credentials, or deployment-specific values in code, tests, fixtures, or docs. Use synthetic examples. |
| AN-5 | Should | Stay compatible with the pinned OpenClaw release recorded in `COMPATIBILITY.md`, and fail closed on incompatible service responses. |

## Change log

- v1.1: AR-6 changed to a single search entry point covering native memory; added AR-9 cross-language recall; retrieval model updated so the adapter routes to native memory.

## Out of scope

- Indexing, rebuilding, or writing memory.
- Storing or indexing curated memory, daily notes, or recent sessions (native memory owns them; the adapter only routes queries to it).
- Promoting facts into curated memory.

## Changing these requirements

Requirement changes need the deploying owner's approval and are made in a
reviewed pull request. Pull requests cite the requirement IDs they serve and
state any requirement they weaken.
