// Templates a new page can start from. These come with the wiki; any page marked as a template in a space is offered
// there too. Their words are English: a page is written in the company's language, so the writer replaces them.

export interface Template {
  id: string;
  name: string;
  description: string;
  html: string;
}

export const TEMPLATES: Template[] = [
  {
    id: "how-to",
    name: "How-to",
    description: "Steps to get one thing done, and what to do when it goes wrong.",
    html: `<p>What this does and when you need it, in one or two sentences.</p>
<h2>Before you start</h2>
<ul><li><p>Access or tools you need</p></li></ul>
<h2>Steps</h2>
<ol><li><p>First step</p></li><li><p>Second step</p></li><li><p>Check that it worked</p></li></ol>
<h2>If something goes wrong</h2>
<p>What to check, and whom to ask.</p>`,
  },
  {
    id: "policy",
    name: "Policy",
    description: "A rule people must follow and confirm they have read.",
    html: `<p>Why this policy exists, in one or two sentences.</p>
<h2>Who it applies to</h2>
<p>Everyone, or the teams and roles it covers.</p>
<h2>The rules</h2>
<ol><li><p>First rule</p></li><li><p>Second rule</p></li></ol>
<h2>Exceptions</h2>
<p>Who may grant one, and how it is recorded.</p>
<h2>Questions</h2>
<p>Whom to ask.</p>`,
  },
  {
    id: "runbook",
    name: "Runbook",
    description: "What on-call does when an alert fires.",
    html: `<p>The alert or symptom this runbook is for.</p>
<h2>Impact</h2>
<p>Who is affected, and how badly.</p>
<h2>Check</h2>
<pre><code>command to see the state</code></pre>
<h2>Fix</h2>
<ol><li><p>First action</p></li><li><p>How to tell it helped</p></li></ol>
<h2>Escalate</h2>
<p>Whom to page, and when.</p>`,
  },
  {
    id: "meeting-notes",
    name: "Meeting notes",
    description: "Who was there, what was decided, who does what.",
    html: `<p><strong>Date:</strong> <br><strong>Present:</strong> </p>
<h2>Agenda</h2>
<ul><li><p>Topic</p></li></ul>
<h2>Decisions</h2>
<ul><li><p>Decision</p></li></ul>
<h2>Actions</h2>
<table><tbody><tr><th><p>What</p></th><th><p>Who</p></th><th><p>By</p></th></tr><tr><td><p></p></td><td><p></p></td><td><p></p></td></tr></tbody></table>`,
  },
  {
    id: "onboarding",
    name: "Onboarding",
    description: "A new person's first days, with links to what they should read.",
    html: `<p>Welcome. This page is your first week, day by day.</p>
<h2>Day one</h2>
<ul><li><p>Accounts and laptop</p></li><li><p>Meet your buddy</p></li></ul>
<h2>Your first week</h2>
<ul><li><p>Pages to read</p></li><li><p>People to meet</p></li></ul>
<h2>Policies to read</h2>
<ul><li><p>Link the policies here</p></li></ul>`,
  },
  {
    id: "decision",
    name: "Decision record",
    description: "A decision, the options weighed and why one was chosen.",
    html: `<h2>Context</h2>
<p>What made a decision necessary.</p>
<h2>Options</h2>
<ul><li><p>Option one</p></li><li><p>Option two</p></li></ul>
<h2>Decision</h2>
<p>What was chosen, and why.</p>
<h2>Consequences</h2>
<p>What changes because of it.</p>`,
  },
];
