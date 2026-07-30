import { redirect } from "next/navigation";

export { renderProcessingRulesPage as renderTemplatesPage } from "../processing-rules/page";

export default function TemplatesPage() {
  redirect("/processing-rules");
}
