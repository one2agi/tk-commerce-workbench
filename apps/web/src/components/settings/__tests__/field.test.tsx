/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Field } from "../field";

describe("Field", () => {
  it("renders label, control children, and help text", () => {
    render(
      <Field id="locale" label="默认语言" help="新建商品时使用">
        <input id="locale" data-testid="control" />
      </Field>
    );
    expect(screen.getByText("默认语言")).toBeInTheDocument();
    expect(screen.getByTestId("control")).toBeInTheDocument();
    expect(screen.getByText("新建商品时使用")).toBeInTheDocument();
  });

  it("renders the dirty marker only when isDirty is true", () => {
    const { rerender, container } = render(
      <Field id="a" label="A">
        <input />
      </Field>
    );
    expect(container.querySelector(".tk-field__dirty-dot")).toBeNull();

    rerender(
      <Field id="a" label="A" isDirty>
        <input />
      </Field>
    );
    expect(container.querySelector(".tk-field__dirty-dot")).not.toBeNull();
  });

  it("renders error text below the control when error is set", () => {
    render(
      <Field id="concurrency" label="并发" error="必须在 1-32 之间">
        <input />
      </Field>
    );
    expect(screen.getByText("必须在 1-32 之间")).toBeInTheDocument();
  });

  it("omits help when not provided", () => {
    const { container } = render(
      <Field id="a" label="A">
        <input />
      </Field>
    );
    expect(container.querySelector(".tk-field__help")).toBeNull();
  });
});
