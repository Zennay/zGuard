require "yaml"
require "pathname"

def pull_request_trigger?(source)
  source.match?(/^  pull_request:\s*(?:#.*)?$/)
end

def self_hosted_runner?(value)
  labels = value.is_a?(Array) ? value : [value]
  labels.any? { |label| label.to_s.strip.gsub(/\A["\']|["\']\z/, "") == "self-hosted" }
end

def pr_self_hosted_findings(source, parsed, relative)
  return [] unless pull_request_trigger?(source)
  return [] unless parsed.is_a?(Hash) && parsed["jobs"].is_a?(Hash)

  parsed["jobs"].filter_map do |job_name, job|
    next unless job.is_a?(Hash)
    runner = job["runs-on"]
    next unless self_hosted_runner?(runner)
    "#{relative}: pull_request job #{job_name.inspect} must not run on a self-hosted runner (#{runner.inspect})"
  end
end

hosted_source = <<~YAML
  on:
    pull_request:
  jobs:
    test:
      runs-on: ubuntu-latest
YAML
raise "hosted PR runner self-test failed" unless pr_self_hosted_findings(hosted_source, YAML.safe_load(hosted_source), "fixture.yml").empty?

self_hosted_source = <<~YAML
  on:
    pull_request:
  jobs:
    test:
      runs-on: [self-hosted, zcloud, vps]
YAML
raise "self-hosted PR runner self-test failed" unless pr_self_hosted_findings(self_hosted_source, YAML.safe_load(self_hosted_source), "fixture.yml").length == 1

manual_source = <<~YAML
  on:
    workflow_dispatch:
  jobs:
    test:
      runs-on: [self-hosted, zcloud, vps]
YAML
raise "manual self-hosted runner self-test failed" unless pr_self_hosted_findings(manual_source, YAML.safe_load(manual_source), "fixture.yml").empty?

root = Pathname.new(__dir__).parent
workflow_dir = root.join(".github", "workflows")
workflows = Dir.children(workflow_dir)
  .select { |name| [".yml", ".yaml"].include?(File.extname(name).downcase) }
  .sort
  .map { |name| workflow_dir.join(name) }

abort "No GitHub Actions workflows found" if workflows.empty?

findings = []
pull_request_workflows = 0
workflows.each do |workflow|
  relative = workflow.relative_path_from(root).to_s
  source = File.read(workflow, encoding: "UTF-8")
  pull_request_workflows += 1 if pull_request_trigger?(source)
  parsed = YAML.safe_load(source, permitted_classes: [], permitted_symbols: [], aliases: true)
  findings.concat(pr_self_hosted_findings(source, parsed, relative))
end

abort "No pull_request workflows were discovered" if pull_request_workflows.zero?
unless findings.empty?
  abort "Pull-request self-hosted runner boundary failed:\n#{findings.join("\n")}"
end

puts "Pull-request runner boundary passed for #{pull_request_workflows} PR workflows across #{workflows.length} workflows"
