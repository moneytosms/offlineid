import { cosineSimilarity, findBestMatch, EnrolledEmbedding } from '../cosineDistance';

describe('cosineSimilarity', () => {
  it('returns 1 for identical (normalised) vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toThrow(
      /dimension mismatch/i,
    );
  });
});

describe('findBestMatch', () => {
  const query = new Float32Array([1, 0, 0]);
  const enrolled: EnrolledEmbedding[] = [
    { employeeId: 'low', embedding: new Float32Array([0, 1, 0]) }, // score 0
    { employeeId: 'high', embedding: new Float32Array([1, 0, 0]) }, // score 1
    { employeeId: 'mid', embedding: new Float32Array([0.6, 0.8, 0]) }, // score 0.6
  ];

  it('picks the highest scorer above threshold', () => {
    const res = findBestMatch(query, enrolled, 0.65);
    expect(res).not.toBeNull();
    expect(res!.employeeId).toBe('high');
    expect(res!.score).toBeCloseTo(1, 6);
  });

  it('returns null when best score is below threshold', () => {
    const onlyLow: EnrolledEmbedding[] = [
      { employeeId: 'mid', embedding: new Float32Array([0.6, 0.8, 0]) }, // 0.6
      { employeeId: 'low', embedding: new Float32Array([0, 1, 0]) }, // 0
    ];
    expect(findBestMatch(query, onlyLow, 0.65)).toBeNull();
  });

  it('defaults threshold to 0.40', () => {
    // score 0.6 ≥ default 0.40 → matches.
    expect(
      findBestMatch(query, [{ employeeId: 'mid', embedding: new Float32Array([0.6, 0.8, 0]) }]),
    ).not.toBeNull();
    // score 0.3 < default 0.40 → no match.
    expect(
      findBestMatch(query, [{ employeeId: 'dim', embedding: new Float32Array([0.3, 0.954, 0]) }]),
    ).toBeNull();
  });
});
