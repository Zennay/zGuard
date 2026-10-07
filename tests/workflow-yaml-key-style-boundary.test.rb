require "yaml"
require "pathname"

def key_style_findings(node, path = [], findings = [])
  if node.is_a?(Psych::Nodes::Mapping)
    node.children.each_slice(2) do |key_node, value_node|
      if key_node.is_a?(Psych::Nodes::Scalar)
        segment = key_node.value
        explicit_tag = key_node.tag && !key_node.tag.empty?

        unless key_node.plain && !key_node.quoted && !explicit_tag
          findings << {
            kind: "non-plain-key",
            value: key_node.value,
            line: key_node.start_line + 1,
            path: (path + [key_node.value]).join(".")
          }
        end
      else
        segment = "<complex-key>"
        findings << {
          kind: "complex-key",
          value: key_node.class.name,
          line: key_node.start_line + 1,
          path: (path + [segment]).join(".")
        }
      end

      key_style_findings(key_node, path, findings)
      key_style_findings(value_node, path + [segment], findings)
    end
  elsif node.respond_to?(:children) && node.children
    node.children.each { |child| key_style_findings(child, path, findings) }
  end

  findings
end

safe_fixture = Psych.parse_stream(<<~YAML)
  permissions:
    contents: read
  jobs:
    validate:
      runs-on: ubuntu-latest
YAML
abort "plain-key detector self-test failed" unless key_style_findings(safe_fixture).empty?

quoted_fixture = Psych.parse_stream(<<~YAML)
  "permissions":
    'contents': read
YAML
quoted_findings = key_style_findings(quoted_fixture)
abort "double-quoted key self-test failed" unless quoted_findings.any? { |f| f[:value] == "permissions" }
abort "single-quoted key self-test failed" unless quoted_findings.any? { |f| f[:value] == "contents" }

tagged_fixture = Psych.parse_stream(<<~YAML)
  !!str permissions:
    contents: read
YAML
abort "tagged key self-test failed" unless key_style_findings(tagged_fixture).any? { |f| f[:value] == "permissions" }

root = Pathname.new(__dir__).parent
workflow_dir = root.join(".github", "workflows")
workflows = Dir[workflow_dir.join("*.{yml,yaml}")].sort

abort "No GitHub Actions workflows found" if workflows.empty?

workflows.each do |workflow|
  relative = Pathname.new(workflow).relative_path_from(root).to_s
  source = File.read(workflow, encoding: "UTF-8")

  begin
    syntax_tree = Psych.parse_stream(source)
  rescue Psych::SyntaxError => error
    abort "#{relative}: invalid YAML at line #{error.line}, column #{error.column}: #{error.problem}"
  end

  findings = key_style_findings(syntax_tree)
  next if findings.empty?

  detail = findings.map do |finding|
    "#{finding[:kind]} #{finding[:value].inspect} at #{finding[:path]} line #{finding[:line]}"
  end.join(", ")

  abort [
    "#{relative}: workflow mapping keys must remain plain untagged scalars",
    detail,
    "Keep policy-relevant keys source-visible so repository CI guards cannot be bypassed with alternate YAML key syntax."
  ].join(": ")
end

puts "Workflow YAML key-style boundary passed for #{workflows.length} workflows"
