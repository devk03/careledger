CREATE UNIQUE INDEX extraction_runs_one_validated_result_per_job
ON extraction_runs (job_id)
WHERE job_id IS NOT NULL;
