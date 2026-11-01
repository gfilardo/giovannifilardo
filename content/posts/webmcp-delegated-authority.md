---
title: "WebMCP: Who can confirm on the user’s behalf?"
slug: webmcp-delegated-authority
date: "2026-10-31"
description: "From a broad user request to a specific commitment: how applications can reason about delegated authority."
tags:
  - WebMCP
  - AI
  - API_design
  - architecture
series:
  id: webmcp-agent-ready-web
  title: "WebMCP and the agent-ready web"
  part: 3
draft: true
---

“Get me a ride home” is a clear request about an outcome.

It is less clear about spending €85, accepting a cancellation fee, or choosing a premium vehicle.

An agent must translate the request into specific decisions. A website accepting those decisions needs to know which ones the user authorized the agent to make.

This is where agent-ready products encounter a boundary that an ordinary permission check cannot fully describe.

## Three different questions
```mermaid Signed in: identity established. Allowed: account may book. Covered: valid approval or delegated authority covers this ride.
flowchart TD
    R[Request to book an EUR 85 ride] --> I{Signed in?}
    I -->|No| X[Reject]
    I -->|Yes| P{Allowed?}
    P -->|No| X
    P -->|Yes| A{Covered?}
    A -->|No| C[Obtain appropriate approval]
    A -->|Yes| V[Continue transaction checks]
```


Authentication establishes who is using the application.

Authorization establishes what that identity is permitted to do.

Transaction approval establishes whether this particular operation falls within the user’s decision or delegated authority. [OWASP’s Transaction Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html) explicitly distinguishes authentication from transaction authorization and recommends verification of significant transaction data.

A user may be signed in, permitted to book rides, and have a valid payment method. None of those facts alone establishes approval for an €85 journey.

A human confirmation view traditionally presented a specific offer and collected an action associated with it. A backend should already have checked the relevant approval. Agent interaction adds another participant interpreting what the user wants and deciding when their authority is sufficient.

## Delegation can be useful and bounded
```mermaid Proposed authority model. WebMCP does not establish or verify this delegation.
flowchart TD
    G[User goal: get me home] --> D[Established delegation: rides up to EUR 40]
    D --> O[Agent obtains an offer]
    O --> S{In scope?}
    S -->|Yes| P[Proceed within delegated authority]
    S -->|No: EUR 85| U[Request approval for this offer]
    U --> A{Approved?}
    A -->|Yes| B[Submit booking]
    A -->|No| N[Do not book]
    P --> B
```


Requiring a confirmation for every action would limit the value of an assistant.

A user might reasonably permit rides home up to €40, using a specified payment method and excluding premium vehicles. Within that scope, the agent can make a useful decision without interrupting.

An €85 quote falls outside the authority.

The important design work is making the boundary explicit enough to evaluate. “Use reasonable judgment” may be useful conversational context, but it leaves the application with little concrete evidence about the transaction it should accept.

Different operations need different boundaries. A shopping assistant might have a total budget. A scheduling assistant might be allowed to move internal meetings but not cancel customer appointments.

The application needs a policy appropriate to its domain. This follows the established [least-privilege principle](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html#enforce-least-privileges); the budget and ride restrictions here are proposed domain rules, not WebMCP-defined permission scopes.

## Whose assertion can the application trust?

An agent may report that the user approved the purchase. That creates a trust question: what makes the assertion acceptable to the website?

A site-controlled confirmation flow can record approval directly. An established delegated-authority arrangement could allow decisions within a defined scope. Accepting an external agent’s approval would require an explicit trust arrangement and a verifiable representation of that authority.

These are architectural choices, not capabilities automatically supplied by a tool annotation.

The current WebMCP draft recognizes broader questions around agent identity, permissions, and delegation, while leaving important agent-security responsibilities outside its scope. See its [agent baseline and responsibility boundaries](https://webmachinelearning.github.io/webmcp/#agent-baseline-capabilities). The draft distinguishes browser-session capabilities from the agent’s own security responsibilities; it does not define a universal proof of delegated consent.

## Consent needs an object

A generic “approved” flag loses essential information.

Approval should refer to something: an offer, an action, or a bounded class of actions. Its useful lifetime and material conditions should be clear. OWASP’s [transaction-authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html) covers server-side enforcement, protection against changes to transaction data and limited authorization lifetimes. Applying those principles to a ride offer is the architecture proposed here.

In the ride example, approving a fixed €85 quote should not silently become approval for €95. A different policy might permit a capped final fare, but the scope of that policy must be explicit.

Withdrawal matters too. A standing delegation that has been revoked should not remain usable merely because an agent retained a reference to it.

These concerns predate WebMCP. Agentic interaction gives them a new operational setting: the application, the agent provider, and the user may hold different parts of the context needed to assess an action.

## The product decision behind the architecture

Teams must decide which commitments may be delegated, under which conditions, and what requires renewed participation from the user.

Those decisions affect the product experience as much as its security model. Interrupt too often and the assistant becomes tedious. Infer too much and the product accepts actions the user did not intend.

A useful starting point is to identify the smallest scope that enables the desired workflow. Make it understandable to the user, enforceable by the application, and inspectable after execution.

For a ride, that might mean authority for one quoted journey or a clearly bounded recurring policy.

The goal is a reliable connection between the user’s intent and the commitment the system ultimately makes.

## An accompanying example

An [accompanying working example](https://github.com/gfilardo/gf-blog-examples) shows an application checking approval for a specific ride offer. The repository’s README links to the example and its setup instructions. It demonstrates the approval check; it does not establish that an independent agent has trustworthy authority to approve on someone’s behalf.

## References and further reading

- [OWASP: Transaction Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html) — significant transaction data, separation from login, server enforcement, expiry and transaction changes.
- [OWASP: Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) — least privilege and per-request checks.
- [WebMCP: Agent baseline capabilities](https://webmachinelearning.github.io/webmcp/#agent-baseline-capabilities) — session inheritance and the boundary of the specification’s protections.
- [WebMCP: Consequential annotation](https://webmachinelearning.github.io/webmcp/#mitigation-consequential-annotation) — a signal for agent-host confirmation policy, not an approval credential issued to the application.
- [Chrome: WebMCP tool security](https://developer.chrome.com/docs/ai/webmcp/secure-tools) — implementation guidance for sites exposing actions to agents.

*Documentation checked on 30 October 2026. WebMCP is evolving; specification text, browser implementation and agent-host behavior should be checked separately.*
