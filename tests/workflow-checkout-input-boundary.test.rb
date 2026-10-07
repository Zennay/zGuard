require "yaml"
require "pathname"
require "set"

ALLOWED_CHECKOUT_INPUTS = Set.new(%w[persist-credentials repository ref]).freeze

def checkout_input_findings(parsed, relative)
  findings = []
  return findings unless parsed.is_a?(Hash)
  jobs = parsed["jobs"]
  return findings unless jobs.is_a?(Hash)

  jobs.each do |job_name, job|
    next unless job.is_a?(Hash)
    steps = job["steps"]
    next unless steps.is_a?(Array)

    steps.each_with_index do |step, index|
      next unless step.is_a?(Hash)
      reference = step["uses"]
      next unless reference.is_a?(String) && reference.start_with?("actions/checkout@")

      with = step["with"]
      unless with.is_a?(Hash)
        findings << "#{relative}: job #{job_name.inspect} checkout step ##{index + 1} must declare a with mapping"
        next
      end

      extras = with.keys.map(&:to_s).reject { |key| ALLOWED_CHECKOUT_INPUTS.include?(key) }
      unless extras.empty?
        findings << "#{relative}: job #{job_name.inspect} checkout step ##{index + 1} uses unapproved checkout inputs #{extras.sort.inspect}"
      end

      unless with["persist-credentials"] == false
        findings << "#{relative}: job #{job_name.inspect} checkout step ##{index + 1} must set persist-credentials: false"
      end
    end
  end

  findings
end

safe_fixture = YAML.safe_load(<<~YAML)
  jobs:
    test:
      steps:
        - uses: actions/checkout@0123456789012345678901234567890123456789
          with:
            repository: ${{ github.event.pull_request.head.repo.full_name || github.repository }}
            ref: ${{ github.event.pull_request.head.sha || github.sha }}
            persist-credentials: false
YAML
raise "safe checkout input self-test failed" unless checkout_input_findings(safe_fixture, "fixture.yml").empty?

[
  ["missing with", "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@0123456789012345678901234567890123456789\n"],
  ["persisted credentials", "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@0123456789012345678901234567890123456789\n        with:\n          persist-credentials: true\n"],
  ["token input", "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@0123456789012345678901234567890123456789\n        with:\n          persist-credentials: false\n          token: secret\n"],
  ["submodule input", "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@0123456789012345678901234567890123456789\n        with:\n          persist-credentials: false\n          submodules: recursive\n"],
  ["path input", "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@0123456789012345678901234567890123456789\n        with:\n          persist-credentials: false\n          path: nested\n"],
].each do |label, source|
  findings = checkout_input_findings(YAML.safe_load(source), "fixture.yml")
  raise "#{label} self-test failed" if findings.empty?
end

root = Pathname.new(__dir__).parent
workflow_dir = root.join(".github", "workflows")
workflows = Dir.children(workflow_dir)
  .select { |name| [".yml", ".yaml"].include?(File.extname(name).downcase) }
  .sort
  .map { |name| workflow_dir.join(name) }

abort "No GitHub Actions workflows found" if workflows.empty?

findings = []
checkout_steps = 0
workflows.each do |workflow|
  relative = workflow.relative_path_from(root).to_s
  parsed = YAML.safe_load(
    File.read(workflow, encoding: "UTF-8"),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: true
  )
  checkout_steps += parsed.fetch("jobs", {}).values.sum do |job|
    next 0 unless job.is_a?(Hash) && job["steps"].is_a?(Array)
    job["steps"].count { |step| step.is_a?(Hash) && step["uses"].is_a?(String) && step["uses"].start_with?("actions/checkout@") }
  end if parsed.is_a?(Hash)
  findings.concat(checkout_input_findings(parsed, relative))
end

abort "No checkout steps were discovered" if checkout_steps.zero?
unless findings.empty?
  abort "Workflow checkout input boundary failed; allowed inputs: #{ALLOWED_CHECKOUT_INPUTS.to_a.sort.join(", ")}\n#{findings.join("\n")}"
end

puts "Workflow checkout input boundary passed for #{checkout_steps} checkout steps across #{workflows.length} workflows"
