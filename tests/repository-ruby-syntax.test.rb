# frozen_string_literal: true

require "pathname"

ROOT = Pathname(__dir__).parent

RUBY_SHEBANG = /\A#!.*(?:\/|\s)ruby(?:\s|$)/

def has_ruby_shebang?(path)
  first_line = File.open((ROOT / path).to_s, "rb", &:gets).to_s
  RUBY_SHEBANG.match?(first_line)
end

def tracked_ruby_files
  output = IO.popen(["git", "ls-files", "-z"], chdir: ROOT.to_s, &:read)
  output
    .split("\0")
    .reject(&:empty?)
    .map { |path| Pathname(path) }
    .select { |path| path.extname.downcase == ".rb" || has_ruby_shebang?(path) }
    .sort
end

def compile_ruby(source, filename)
  RubyVM::InstructionSequence.compile(source, filename, filename, 1)
end

raise "env Ruby shebang discovery self-test failed" unless RUBY_SHEBANG.match?("#!/usr/bin/env ruby\n")
raise "direct Ruby shebang discovery self-test failed" unless RUBY_SHEBANG.match?("#!/usr/bin/ruby\n")
raise "non-Ruby shebang discovery self-test failed" if RUBY_SHEBANG.match?("#!/usr/bin/env bash\n")

compile_ruby("value = 1\nputs value\n", "self-test-valid.rb")

begin
  compile_ruby("def broken(\nend\n", "self-test-invalid.rb")
rescue SyntaxError
  # Expected: prove the parser rejects invalid Ruby before validating repository files.
else
  raise "self-test-invalid.rb must raise SyntaxError"
end

ruby_files = tracked_ruby_files
raise "repository must contain tracked Ruby files" if ruby_files.empty?

ruby_files.each do |ruby_file|
  source = (ROOT / ruby_file).read(encoding: "UTF-8")
  begin
    compile_ruby(source, ruby_file.to_s)
  rescue SyntaxError => error
    message = error.message.lines.first&.strip || "Ruby syntax error"
    raise "#{ruby_file}: #{message}"
  end
end

puts "Repository Ruby syntax contract passed for #{ruby_files.length} tracked files"
