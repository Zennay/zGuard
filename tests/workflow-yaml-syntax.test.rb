require "yaml"
require "pathname"

def duplicate_mapping_keys(node, path = [], findings = [])
  if node.is_a?(Psych::Nodes::Mapping)
    seen = {}

    node.children.each_slice(2) do |key_node, value_node|
      segment = key_node.is_a?(Psych::Nodes::Scalar) ? key_node.value : "<complex-key>"

      if key_node.is_a?(Psych::Nodes::Scalar)
        identity = [key_node.tag, key_node.value]
        if seen.key?(identity)
          findings << {
            key: key_node.value,
            path: (path + [key_node.value]).join("."),
            line: key_node.start_line + 1,
            first_line: seen[identity]
          }
        else
          seen[identity] = key_node.start_line + 1
        end
      end

      duplicate_mapping_keys(key_node, path, findings)
      duplicate_mapping_keys(value_node, path + [segment], findings)
    end
  elsif node.respond_to?(:children) && node.children
    node.children.each { |child| duplicate_mapping_keys(child, path, findings) }
  end

  findings
end

self_test = Psych.parse_stream(<<~YAML)
  jobs:
    build:
      runs-on: ubuntu-latest
      runs-on: self-hosted
YAML
self_findings = duplicate_mapping_keys(self_test)
abort "Duplicate-key detector self-test failed" unless self_findings.any? { |finding| finding[:key] == "runs-on" }

root = Pathname.new(__dir__).parent
workflow_dir = root.join(".github", "workflows")
workflows = Dir[workflow_dir.join("*.{yml,yaml}")].sort

abort "No GitHub Actions workflows found" if workflows.empty?

workflow_names = {}
job_display_names = {}

workflows.each do |workflow|
  relative = Pathname.new(workflow).relative_path_from(root).to_s
  source = File.read(workflow, encoding: "UTF-8")

  begin
    syntax_tree = Psych.parse_stream(source)
    parsed = YAML.safe_load(source, permitted_classes: [], permitted_symbols: [], aliases: true)
  rescue Psych::SyntaxError => error
    abort "#{relative}: invalid YAML at line #{error.line}, column #{error.column}: #{error.problem}"
  end

  duplicates = duplicate_mapping_keys(syntax_tree)
  unless duplicates.empty?
    detail = duplicates.map do |finding|
      "#{finding[:path]} at line #{finding[:line]} (first defined at line #{finding[:first_line]})"
    end.join(", ")
    abort "#{relative}: duplicate YAML mapping keys: #{detail}"
  end

  abort "#{relative}: workflow root must be a mapping" unless parsed.is_a?(Hash)

  workflow_name = parsed["name"]
  unless workflow_name.is_a?(String) && !workflow_name.strip.empty?
    abort "#{relative}: workflow must define a non-empty top-level name"
  end
  if workflow_names.key?(workflow_name)
    abort "#{relative}: workflow name #{workflow_name.inspect} duplicates #{workflow_names[workflow_name]}"
  end
  workflow_names[workflow_name] = relative

  jobs = parsed["jobs"]
  abort "#{relative}: workflow must define a non-empty jobs mapping" unless jobs.is_a?(Hash) && !jobs.empty?

  jobs.each do |job_name, job|
    abort "#{relative}: job #{job_name.inspect} must be a mapping" unless job.is_a?(Hash)

    display_name = job["name"]
    unless display_name.is_a?(String) && !display_name.strip.empty?
      abort "#{relative}: job #{job_name.inspect} must define a non-empty display name"
    end

    identity = "#{relative}:#{job_name}"
    if job_display_names.key?(display_name)
      abort "#{identity}: job display name #{display_name.inspect} duplicates #{job_display_names[display_name]}"
    end
    job_display_names[display_name] = identity
  end
end

puts "Workflow YAML, duplicate-key, and check-identity contract passed for #{workflows.length} workflows"
