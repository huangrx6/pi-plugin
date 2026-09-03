/**
 * workflow-command.test.ts — P4-C2 (workflow grammar tests).
 *
 * 3-state result: command / syntax-error / not-workflow-command.
 * `here` takes exactly zero arguments (LOCK 23).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseWorkflowCommand } from "./workflow-command.ts";

describe("workflow-command: 3-state result", () => {
 it("'here' alone → command { kind: 'here' }", () => {
  const r = parseWorkflowCommand("here");
  assert.equal(r.kind, "command");
  if (r.kind === "command") assert.equal(r.command.kind, "here");
 });

 it("'here 17' → syntax-error (extra args never silently dropped)", () => {
  const r = parseWorkflowCommand("here 17");
  assert.equal(r.kind, "syntax-error");
  if (r.kind === "syntax-error") assert.equal(r.verb, "here");
 });

 it("'here x y z' → syntax-error (multi extra args)", () => {
  const r = parseWorkflowCommand("here x y z");
  assert.equal(r.kind, "syntax-error");
 });

 it("'HERE' (uppercase) → syntax-error (case variant per P2-C precedent)", () => {
  const r = parseWorkflowCommand("HERE");
  assert.equal(r.kind, "syntax-error");
 });

 it("'Here' (title case) → syntax-error", () => {
  const r = parseWorkflowCommand("Here");
  assert.equal(r.kind, "syntax-error");
 });

 it("'ready' → not-workflow-command (B3 fallthrough handles)", () => {
  assert.equal(parseWorkflowCommand("ready").kind, "not-workflow-command");
 });

 it("'next' → not-workflow-command", () => {
  assert.equal(parseWorkflowCommand("next").kind, "not-workflow-command");
 });

 it("'start' → not-workflow-command", () => {
  assert.equal(parseWorkflowCommand("start").kind, "not-workflow-command");
 });

 it("'finish' → not-workflow-command", () => {
  assert.equal(parseWorkflowCommand("finish").kind, "not-workflow-command");
 });

 it("'blocked' → not-workflow-command", () => {
  assert.equal(parseWorkflowCommand("blocked").kind, "not-workflow-command");
 });

 it("'' (empty) → not-workflow-command", () => {
  assert.equal(parseWorkflowCommand("").kind, "not-workflow-command");
 });

 it("'   ' (whitespace only) → not-workflow-command", () => {
  assert.equal(parseWorkflowCommand("   ").kind, "not-workflow-command");
 });

 it("null / undefined → not-workflow-command", () => {
  assert.equal(parseWorkflowCommand(null).kind, "not-workflow-command");
  assert.equal(parseWorkflowCommand(undefined).kind, "not-workflow-command");
 });
});
