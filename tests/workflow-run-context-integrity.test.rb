require "yaml"
require "pathname"

def safe_working_directory?(root, value)
  return false unless value.is_a?(String) && !value.empty?
  return false if value.include?("${{") || value.include?("\\")

  candidate = Pathname.new(value)
  return false if candidate.absolute?

  segments = candidate.each_filename.to_a
  return false if segments.empty? || segments.any? { |segment| ["", ".", ".."].include?(segment) }

  target = root.join(candidate).cleanpath
  return false unless target.to_s.start_with?("#{root}/")
  target.directory?
end

def validate_run_context(parsed, relative, root)
  return 0 unless parsed.is_a?(Hash)
  raise "#{relative}: workflow-level defaults are forbidden; make each run context explicit" if parsed.key?("defaults")

  jobs = parsed["jobs"]
  return 0 unless jobs.is_a?(Hash)
  checked = 0

  jobs.each do |job_name, job|
    next unless job.is_a?(Hash)
    if job.key?("defaults")
      raise "#{relative}: job #{job_name.inspect} defaults are forbidden; make each run context explicit"
    end

    steps = job["steps"]
    next unless steps.is_a?(Array)

    steps.each_with_index do |step, index|
      next unless step.is_a?(Hash)

      if step.key?("shell") && step["shell"] != "bash"
        raise "#{relative}: job #{job_name.inspect} step ##{index + 1} explicit shell must be exactly bash; got #{step["shell"].inspect}"
      end

      if step.key?("working-directory")
        directory = step["working-directory"]
        unless safe_working_directory?(root, directory)
          raise "#{relative}: job #{job_name.inspect} step ##{index + 1} working-directory must be a literal existing repository-relative directory; got #{directory.inspect}"
        end
      end
      checked += 1 if step.key?("run")
    end
  end

  checked
end

root = Pathname.new(__dir__).parent.realpath

raise "safe working-directory self-test failed" unless safe_working_directory?(root, "zbrowse/gateway")
raise "absolute working-directory self-test failed" if safe_working_directory?(root, "/tmp")
raise "parent traversal self-test failed" if safe_working_directory?(root, "../outside")
raise "expression working-directory self-test failed" if safe_working_directory?(root, "${{ github.workspace }}")
raise "backslash working-directory self-test failed" if safe_working_directory?(root, "zbrowse\\gateway")
raise "missing working-directory self-test failed" if safe_working_directory?(root, "does-not-exist")

[
  ["workflow defaults", <<~YAML],
    defaults:
      run:
        shell: sh
    jobs: {}
  YAML
  ["job defaults", <<~YAML],
    jobs:
      test:
        defaults:
          run:
            working-directory: zbrowse
        steps: []
  YAML
  ["non-bash shell", <<~YAML]
    jobs:
      test:
        steps:
          - run: echo ok
            shell: sh
  YAML
].each do |label, source|
  begin
    validate_run_context(YAML.safe_load(source), "fixture.yml", root)
    raise "#{label} self-test failed"
  rescue RuntimeError => error
    raise if error.message.end_with?("self-test failed")
  end
end

valid_fixture = YAML.safe_load(<<~YAML)
  jobs:
    test:
      steps:
        - run: echo ok
        - run: pwd
          shell: bash
          working-directory: zbrowse/gateway
YAML
raise "valid run-context self-test failed" unless validate_run_context(valid_fixture, "fixture.yml", root) == 2

workflow_dir = root.join(".github", "workflows")
workflows = Dir.children(workflow_dir)
  .select { |name| [".yml", ".yaml"].include?(File.extname(name).downcase) }
  .sort
  .map { |name| workflow_dir.join(name) }

abort "No GitHub Actions workflows found" if workflows.empty?

checked = 0
workflows.each do |workflow|
  relative = workflow.relative_path_from(root).to_s
  parsed = YAML.safe_load(
    File.read(workflow, encoding: "UTF-8"),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: true
  )

  begin
    checked += validate_run_context(parsed, relative, root)
  rescue RuntimeError => error
    abort error.message
  end
end

abort "No workflow run steps were validated" if checked.zero?
puts "Workflow run-context integrity passed for #{checked} run steps across #{workflows.length} workflows"
