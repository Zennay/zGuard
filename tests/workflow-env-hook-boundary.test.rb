require "yaml"
require "pathname"

FORBIDDEN_ENV_KEYS = %w[
  BASH_ENV ENV PATH
  NODE_OPTIONS NODE_PATH
  PYTHONHOME PYTHONPATH PYTHONSTARTUP
  RUBYOPT RUBYLIB
  PERL5OPT PERL5LIB
  LD_PRELOAD LD_LIBRARY_PATH
  DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH
  GITHUB_ENV GITHUB_PATH
].to_set.freeze

def env_findings(env, label)
  return [] if env.nil?
  raise "#{label}: env must be a mapping" unless env.is_a?(Hash)

  env.keys.filter_map do |key|
    normalized = key.to_s.upcase
    next unless FORBIDDEN_ENV_KEYS.include?(normalized)
    "#{label}: forbidden execution-hook environment variable #{key.inspect}"
  end
end

def validate_workflow_env(parsed, relative)
  return [] unless parsed.is_a?(Hash)
  findings = env_findings(parsed["env"], "#{relative}: workflow")
  jobs = parsed["jobs"]
  return findings unless jobs.is_a?(Hash)

  jobs.each do |job_name, job|
    next unless job.is_a?(Hash)
    findings.concat(env_findings(job["env"], "#{relative}: job #{job_name.inspect}"))

    steps = job["steps"]
    next unless steps.is_a?(Array)
    steps.each_with_index do |step, index|
      next unless step.is_a?(Hash)
      findings.concat(env_findings(step["env"], "#{relative}: job #{job_name.inspect} step ##{index + 1}"))
    end
  end

  findings
end

require "set"

safe_fixture = YAML.safe_load(<<~YAML)
  env:
    EXPECTED_SHA: deadbeef
  jobs:
    validate:
      steps:
        - run: echo "$EXPECTED_SHA"
          env:
            CHECK_NAME: smoke
YAML
raise "safe env self-test failed" unless validate_workflow_env(safe_fixture, "fixture.yml").empty?

[
  ["workflow BASH_ENV", "env:\n  BASH_ENV: ./bootstrap.sh\njobs: {}\n"],
  ["job NODE_OPTIONS", "jobs:\n  test:\n    env:\n      NODE_OPTIONS: --require ./hook.js\n    steps: []\n"],
  ["step LD_PRELOAD", "jobs:\n  test:\n    steps:\n      - run: true\n        env:\n          LD_PRELOAD: ./hook.so\n"],
  ["casefold PATH", "jobs:\n  test:\n    steps:\n      - run: true\n        env:\n          Path: /tmp/bin\n"],
].each do |label, source|
  findings = validate_workflow_env(YAML.safe_load(source), "fixture.yml")
  raise "#{label} self-test failed" unless findings.length == 1
end

root = Pathname.new(__dir__).parent
workflow_dir = root.join(".github", "workflows")
workflows = Dir.children(workflow_dir)
  .select { |name| [".yml", ".yaml"].include?(File.extname(name).downcase) }
  .sort
  .map { |name| workflow_dir.join(name) }

abort "No GitHub Actions workflows found" if workflows.empty?

findings = []
workflows.each do |workflow|
  relative = workflow.relative_path_from(root).to_s
  parsed = YAML.safe_load(
    File.read(workflow, encoding: "UTF-8"),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: true
  )
  findings.concat(validate_workflow_env(parsed, relative))
end

unless findings.empty?
  abort "Workflow environment execution-hook boundary failed:\n#{findings.join("\n")}"
end

puts "Workflow environment hook boundary passed for #{workflows.length} workflows"
