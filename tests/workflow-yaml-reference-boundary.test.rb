require "yaml"
require "pathname"

def yaml_reference_findings(node, path = [], findings = [])
  if node.respond_to?(:anchor) && node.anchor && !node.anchor.empty?
    findings << {
      kind: node.is_a?(Psych::Nodes::Alias) ? "alias" : "anchor",
      value: node.anchor,
      line: node.start_line + 1,
      path: path.join(".")
    }
  end

  if node.is_a?(Psych::Nodes::Mapping)
    node.children.each_slice(2) do |key_node, value_node|
      segment = key_node.is_a?(Psych::Nodes::Scalar) ? key_node.value : "<complex-key>"

      if key_node.is_a?(Psych::Nodes::Scalar) && key_node.value == "<<"
        findings << {
          kind: "merge-key",
          value: "<<",
          line: key_node.start_line + 1,
          path: (path + ["<<"]).join(".")
        }
      end

      yaml_reference_findings(key_node, path, findings)
      yaml_reference_findings(value_node, path + [segment], findings)
    end
  elsif node.respond_to?(:children) && node.children
    node.children.each { |child| yaml_reference_findings(child, path, findings) }
  end

  findings
end

unsafe_fixture = Psych.parse_stream(<<~YAML)
  defaults: &shared
    runs-on: ubuntu-latest
  jobs:
    validate:
      <<: *shared
YAML

unsafe_findings = yaml_reference_findings(unsafe_fixture)
abort "anchor detector self-test failed" unless unsafe_findings.any? { |f| f[:kind] == "anchor" && f[:value] == "shared" }
abort "alias detector self-test failed" unless unsafe_findings.any? { |f| f[:kind] == "alias" && f[:value] == "shared" }
abort "merge-key detector self-test failed" unless unsafe_findings.any? { |f| f[:kind] == "merge-key" }

safe_fixture = Psych.parse_stream(<<~YAML)
  name: Literal reference characters
  env:
    AMPERSAND: "&not-an-anchor"
    STAR: "*not-an-alias"
YAML
abort "quoted literal self-test failed" unless yaml_reference_findings(safe_fixture).empty?

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

  findings = yaml_reference_findings(syntax_tree)
  next if findings.empty?

  detail = findings.map do |finding|
    where = finding[:path].empty? ? "<root>" : finding[:path]
    "#{finding[:kind]} #{finding[:value].inspect} at #{where} line #{finding[:line]}"
  end.join(", ")

  abort [
    "#{relative}: YAML anchors, aliases, and merge keys are forbidden in validation workflows",
    detail,
    "Keep security- and quality-relevant workflow configuration explicit so static policy gates inspect the effective values directly."
  ].join(": ")
end

puts "Workflow YAML reference boundary passed for #{workflows.length} workflows"
