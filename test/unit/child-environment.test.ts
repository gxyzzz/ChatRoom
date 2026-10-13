import assert from "node:assert/strict";
import test from "node:test";
import { childEnvironment } from "#core/runtime/child-environment";

test("supervised child environment filters arbitrary variables but allows explicit overrides", () => {
  const name = "CHATROOM_TEST_CUSTOM_ENV_VAR";
  const original = process.env[name];
  try {
    process.env[name] = "inherited";
    const inherited = childEnvironment(undefined);
    assert.equal(inherited[name], undefined);
    assert.equal(childEnvironment({ [name]: "override" })[name], "override");
    assert.equal(process.env[name], "inherited");
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});
